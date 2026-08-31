/**
 * The seven `/internal/fleet` handlers. Each one does at most four things: read the scope the
 * auth hook proved, check the body's epoch against the token's, run the module functions inside
 * ONE tenant transaction, and shape the answer. No business rule lives here — the queue owns
 * ownership, results owns rows, and this file owns the mapping from those outcomes to HTTP.
 *
 * The plane is what a process running untrusted browser automation talks to, so every value on
 * the wire is treated as hostile: zod at the edge, the module's own re-checks behind it, and
 * CHECK constraints at the bottom. Three layers, and none of them is decorative.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { validatorCompiler } from "fastify-type-provider-zod";
import {
  artifactRequestSchema,
  claimRequestSchema,
  completeRequestSchema,
  eventRequestSchema,
  FatalInfraError,
  INTERNAL_ROUTES,
  jobHeartbeatRequestSchema,
  JobCancelledError,
  JobTerminalError,
  NotFoundError,
  registerRequestSchema,
  StaleEpochError,
  toFastifyPath,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationFailedError,
  workerHeartbeatRequestSchema,
  type InternalRouteDescriptor,
} from "@testkite/contract";
import { withTenant, type KernelEnv, type TenantContext, type TkDb } from "../../modules/kernel/index.js";
import {
  claimJobs,
  completeJob,
  fenceJob,
  heartbeatJob,
  mintRunToken,
  readRunPlan,
  recordRunEvent,
  registerWorker,
  renewRunTokenTtl,
  revokeRunTokensFor,
  touchWorker,
  RUN_TOKEN_TTL_SLACK_SECONDS,
  type EpochOutcome,
  type RunTokenScope,
  type WorkerTokenScope,
} from "../../modules/orchestration/index.js";
import {
  createArtifactUpload,
  markArtifactsUploaded,
  writeCaseResults,
  type CaseResultInput,
  type CaseVerdict,
  type S3Config,
  type StepResultInput,
} from "../../modules/results/index.js";
import { createClaimRateLimiter } from "./claim-rate-limit.js";

/** How often a worker must report in. Delivered in the register response; the worker obeys it. */
const WORKER_HEARTBEAT_INTERVAL_MS = 5000;

type MethodUpper = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function descriptorOf(operationId: string): InternalRouteDescriptor {
  const found = INTERNAL_ROUTES.find((r) => r.operationId === operationId);
  // A handler for a route the contract does not publish would be a route with no credential
  // declared, i.e. an unguarded one. Fail at boot, not on the first request.
  if (found === undefined) throw new Error(`INTERNAL_ROUTES has no descriptor for ${operationId}`);
  return found;
}

/**
 * ONE place turns a queue outcome into an HTTP answer. Repeating this per handler is how a
 * single endpoint ends up answering 403 for a cross-tenant id while the rest answer 404.
 */
function unwrap<T>(outcome: EpochOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  switch (outcome.reason) {
    case "not_found":
      throw new NotFoundError("Job run not found.");
    case "cancelled":
      throw new JobCancelledError("The run was cancelled.");
    case "terminal":
      throw new JobTerminalError("The job has already finished.");
    case "stale_epoch":
      throw new StaleEpochError("The lease epoch is stale.", outcome.currentEpoch);
  }
}

/**
 * The body's leaseEpoch must equal the epoch baked into the run token. They can only differ if
 * the worker kept an old token or hand-edited the body; either way it is the same verdict as a
 * stale write, so it answers 409 (not 401) — the worker's STALE_EPOCH branch already knows to
 * stop, whereas its 401 branch would restart the process over what is not a credential problem.
 */
function assertEpochMatchesToken(bodyEpoch: number, scope: RunTokenScope): void {
  if (bodyEpoch !== scope.leaseEpoch) {
    throw new StaleEpochError("leaseEpoch does not match the run token.", scope.leaseEpoch);
  }
}

/**
 * The scope the auth hook proved. Reaching this throw would mean a route was registered without
 * a `tkInternal` descriptor, so the hook skipped it — close the door rather than guess a tenant.
 */
function runScope(req: FastifyRequest): RunTokenScope {
  const scope = req.tkRun;
  if (scope === null) throw new UnauthorizedError("missing run credential");
  return scope;
}

function workerScope(req: FastifyRequest): WorkerTokenScope {
  const scope = req.tkWorker;
  if (scope === null) throw new UnauthorizedError("missing worker credential");
  return scope;
}

/**
 * Parses with the CONTRACT'S schema and reports a failure as 400 VALIDATION_FAILED. The router
 * already validated the same body against the same schema, so this normally cannot fail; doing
 * it anyway is what gives the handler a typed value with the defaults applied, and what keeps a
 * raw ZodError (a 500) out of the answer if a route is ever registered without its schema.
 */
function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationFailedError(
      "The submitted data is invalid.",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  return parsed.data;
}

type CompletedStep = z.infer<typeof completeRequestSchema>["steps"][number];

/**
 * The worker reports a FLAT list of steps carrying their own caseId; `res_case_results` wants
 * one row per case with its steps under it. Grouping happens here, in first-seen order, so the
 * rows land in the order the chain actually executed.
 *
 * A case's `startedAt` is derived as `finishedAt - sum(durationMs)` rather than taken from the
 * wire: it is the PARTITION KEY of both result tables, so a worker with a skewed clock (or a
 * malicious one) must not be able to choose which month its rows land in. The verdict is derived
 * too — a case is `failed` if any of its steps failed, `skipped` only if every step was skipped.
 */
function toCaseResults(
  steps: readonly CompletedStep[],
  chainKey: string,
  finishedAt: Date,
): readonly CaseResultInput[] {
  const order: string[] = [];
  const byCase = new Map<string, CompletedStep[]>();
  for (const step of steps) {
    const bucket = byCase.get(step.caseId);
    if (bucket === undefined) {
      order.push(step.caseId);
      byCase.set(step.caseId, [step]);
    } else {
      bucket.push(step);
    }
  }
  return order.map((caseId) => {
    const own = byCase.get(caseId) ?? [];
    const durationMs = own.reduce((total, s) => total + s.durationMs, 0);
    const verdict: CaseVerdict = own.some((s) => s.status === "failed")
      ? "failed"
      : own.length > 0 && own.every((s) => s.status === "skipped")
        ? "skipped"
        : "passed";
    const stepRows: readonly StepResultInput[] = own.map((s) => ({
      ordinal: s.ordinal,
      verdict: s.status,
      renderedSentence: s.renderedSentence,
      durationMs: s.durationMs,
      failureContext: s.failureContext,
      screenshotArtifactId: s.screenshotArtifactId,
      thumbhash: s.thumbhash,
    }));
    return {
      caseId,
      chainKey,
      verdict,
      startedAt: new Date(finishedAt.getTime() - durationMs),
      finishedAt,
      steps: stepRows,
    };
  });
}

export function internalRoutes(deps: {
  readonly db: TkDb;
  readonly env: KernelEnv;
  /**
   * The clock the claim BUDGET refills on, and nothing else on this plane reads it — every
   * other handler stamps `new Date()` straight from the wall clock, as it must.
   *
   * It is a port because a rate limit is the one thing here whose behaviour is a function of
   * elapsed time: driven over HTTP against a real database, "how much budget refilled while
   * sixty round trips ran" is a property of how loaded the host is, so a test asserting on it
   * is a coin flip dressed up as a contract. With the clock injected, a suite freezes it and
   * the counts become arithmetic. Production passes nothing and gets `Date.now`.
   */
  readonly claimClock?: () => number;
}): FastifyPluginAsync {
  const db = deps.db;
  const claimClock = deps.claimClock ?? ((): number => Date.now());
  /**
   * One budget per plane instance, keyed by worker identity. Built here rather than per request
   * for the obvious reason (state), and per INSTANCE rather than per module so a test can stand
   * two planes up without them sharing a ceiling.
   */
  const claimRate = createClaimRateLimiter();
  const s3: S3Config = {
    endpoint: deps.env.S3_ENDPOINT,
    region: deps.env.S3_REGION,
    bucket: deps.env.S3_BUCKET_ARTIFACTS,
    accessKey: deps.env.S3_ACCESS_KEY,
    secretKey: deps.env.S3_SECRET_KEY,
  };

  return async (app: FastifyInstance): Promise<void> => {
    // Enforce the descriptors' zod schemas inside this plugin's own encapsulated context rather
    // than relying on the parent having installed the compiler — the same silent coupling the
    // authoring plugin documents, where declared-but-unenforced schemas let a malformed path
    // param reach Postgres as a 500 instead of a 400.
    app.setValidatorCompiler(validatorCompiler);

    const route = (
      operationId: string,
      handler: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
    ): void => {
      const descriptor = descriptorOf(operationId);
      app.route({
        method: descriptor.method.toUpperCase() as MethodUpper,
        url: toFastifyPath(descriptor.path),
        // The auth hook reads this exact descriptor — the contract and its enforcement can
        // never drift apart.
        config: { tkInternal: descriptor },
        schema: {
          ...(descriptor.params === undefined ? {} : { params: descriptor.params }),
          ...(descriptor.body === undefined ? {} : { body: descriptor.body }),
        },
        handler,
      });
    };

    route("internalRegister", async (request, reply) => {
      const body = parseBody(registerRequestSchema, request.body);
      const registered = await registerWorker(db, {
        workerId: body.workerId,
        hostname: body.hostname,
        lane: body.lane,
        capacity: body.capacity,
        now: new Date(),
      });
      return reply.code(200).send({
        workerId: body.workerId,
        lane: body.lane,
        workerToken: registered.workerToken,
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
        // A worker put into drain BEFORE it restarted stays in drain: re-registering must not
        // be a way for a machine to un-drain itself.
        drain: registered.drain,
      });
    });

    route("internalWorkerHeartbeat", async (request, reply) => {
      const scope = workerScope(request);
      const body = parseBody(workerHeartbeatRequestSchema, request.body);
      // PSI and RSS are the host's memory-pressure signals (blueprint §5). There is no column
      // for them yet — the memory governance that consumes them is the fleet plan's, and the
      // dashboards are M5 — so they are logged rather than silently dropped on the floor.
      request.log.debug(
        { workerId: scope.workerId, psi: body.psi, rssBytes: body.rssBytes },
        "worker heartbeat",
      );
      const touched = await touchWorker(db, {
        workerId: scope.workerId,
        freeSlots: body.freeSlots,
        now: new Date(),
      });
      return reply.code(200).send({
        command: touched.command,
        workerTokenRenewedAt: touched.workerTokenRenewedAt?.toISOString() ?? null,
      });
    });

    route("internalClaim", async (request, reply) => {
      const scope = workerScope(request);
      const body = parseBody(claimRequestSchema, request.body);
      // The roster row is the authority on WHO and on WHICH LANE, not the body. A worker whose
      // body disagrees with its own token is a confused (or tampered-with) process: 401 makes
      // systemd restart it, and registering again is exactly what reconciles the two.
      if (body.workerId !== scope.workerId) {
        throw new UnauthorizedError("claim workerId does not match the worker token");
      }
      if (body.lane !== scope.lane) {
        throw new UnauthorizedError("claim lane does not match the worker token");
      }
      /*
       * The budget is spent BEFORE the queue is touched, and this is the whole design: a claim is
       * a `FOR UPDATE SKIP LOCKED` scan, a plan read and a token INSERT across two transactions,
       * while the token lookup the auth hook already did is one indexed point read. Throttling
       * after the claim would be worse than useless — it would hand out a job and then refuse to
       * tell the worker about it, leaving the chain `running` with nobody holding it until the
       * reaper takes it back 30s later.
       */
      const budget = claimRate.take(scope.workerId, claimClock());
      if (!budget.allowed) {
        throw new TooManyRequestsError(
          "Too many claims from this worker.",
          budget.retryAfterSeconds,
        );
      }
      const claimed = await claimJobs(db, { workerId: scope.workerId, lane: scope.lane, max: 1 });
      const job = claimed[0];
      // An empty queue is the normal answer for most of a fleet's life, not an error. 204 with
      // no body at all: the worker sleeps `claimIdleMs` and asks again.
      if (job === undefined) return reply.code(204).send();

      const ctx: TenantContext = { teamId: job.teamId };
      // The claim already committed, so this runs under the tenant the claim ANSWERED. If it
      // throws, the job stays `running` with nobody holding it and the reaper takes it back
      // after 30s — the same recovery as a worker that died a moment after claiming.
      const session = await withTenant(db, ctx, async (tx) => {
        const frozen = await readRunPlan(tx, ctx, job.runId);
        if (frozen === undefined) {
          // A queued job whose run has no frozen plan cannot be executed by anyone. That is a
          // control-plane bug (phase 0 writes the plan and the jobs in one transaction), so it
          // is a 500 here, never a "here, run nothing" handed to a worker.
          throw new FatalInfraError(`run ${job.runId} has no frozen plan`);
        }
        const minted = await mintRunToken(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: job.attempt,
          leaseEpoch: job.leaseEpoch,
          workerId: scope.workerId,
          // The token outlives the lease by a minute, so a heartbeat racing the deadline still
          // authenticates instead of turning a late worker into an unauthenticated one.
          expiresAt: new Date(job.leaseExpiresAt.getTime() + RUN_TOKEN_TTL_SLACK_SECONDS * 1000),
        });
        return { runToken: minted.secret, projectId: frozen.projectId, plan: frozen.plan };
      });

      return reply.code(200).send({
        jobRunId: job.jobRunId,
        runId: job.runId,
        teamId: job.teamId,
        projectId: session.projectId,
        chainKey: job.chainKey,
        attempt: job.attempt,
        leaseEpoch: job.leaseEpoch,
        leaseDeadlineAt: job.leaseExpiresAt.toISOString(),
        runToken: session.runToken,
        plan: session.plan,
      });
    });

    route("internalJobHeartbeat", async (request, reply) => {
      const scope = runScope(request);
      const body = parseBody(jobHeartbeatRequestSchema, request.body);
      assertEpochMatchesToken(body.leaseEpoch, scope);
      const ctx: TenantContext = { teamId: scope.teamId };
      const renewed = unwrap(
        await withTenant(db, ctx, async (tx) => {
          const outcome = await heartbeatJob(tx, ctx, {
            jobRunId: scope.jobRunId,
            epoch: body.leaseEpoch,
            now: new Date(),
          });
          // The credential is renewed WITH the lease, in the same transaction and off the same
          // deadline: `expires_at` is stamped once at claim time, so a chain that outlives the
          // claim by more than 90s would otherwise keep a valid lease and lose the token it
          // holds it with. Skipped when the heartbeat matched nothing — a fenced, cancelled or
          // finished job must not have its worker's credential extended.
          if (outcome.ok) {
            await renewRunTokenTtl(tx, ctx, {
              jobRunId: scope.jobRunId,
              leaseEpoch: body.leaseEpoch,
              leaseExpiresAt: outcome.value.leaseExpiresAt,
            });
          }
          return outcome;
        }),
      );
      // `cancel` never reaches here: a cancelled run answers 410 JOB_CANCELLED, which is the
      // stronger statement. `drain` is a host-level decision and is answered by the WORKER
      // heartbeat, which is the call that knows which machine is asking.
      return reply
        .code(200)
        .send({ leaseDeadlineAt: renewed.leaseExpiresAt.toISOString(), command: renewed.command });
    });

    route("internalEvents", async (request, reply) => {
      const scope = runScope(request);
      const body = parseBody(eventRequestSchema, request.body);
      assertEpochMatchesToken(body.leaseEpoch, scope);
      const ctx: TenantContext = { teamId: scope.teamId };
      const recorded = await withTenant(db, ctx, async (tx) => {
        // An event is a write to ANOTHER table, so nothing about it would notice that the chain
        // changed hands. The fence is what makes it notice — and it locks the job row for the
        // rest of this transaction, so a reap cannot slip in between the two statements.
        const fenced = unwrap(await fenceJob(tx, ctx, { jobRunId: scope.jobRunId, epoch: body.leaseEpoch }));
        return recordRunEvent(tx, ctx, {
          jobRunId: scope.jobRunId,
          // The attempt comes from the fenced row, not from the token: the two agree (the epoch
          // matched), and reading the row means there is one source for it.
          attempt: fenced.attempt,
          seq: body.seq,
          kind: body.kind,
          payload: body.payload,
        });
      });
      // 202, and a replay is a SUCCESS: at-least-once delivery makes retries normal traffic,
      // and 409 would make a healthy worker look broken.
      return reply.code(202).send({ accepted: recorded.accepted, duplicate: recorded.duplicate });
    });

    route("internalArtifacts", async (request, reply) => {
      const scope = runScope(request);
      const body = parseBody(artifactRequestSchema, request.body);
      assertEpochMatchesToken(body.leaseEpoch, scope);
      const ctx: TenantContext = { teamId: scope.teamId };
      const now = new Date();
      const slot = await withTenant(db, ctx, async (tx) => {
        const fenced = unwrap(await fenceJob(tx, ctx, { jobRunId: scope.jobRunId, epoch: body.leaseEpoch }));
        return createArtifactUpload(
          tx,
          ctx,
          {
            jobRunId: scope.jobRunId,
            attempt: fenced.attempt,
            kind: body.kind,
            contentType: body.contentType,
            sizeBytes: body.sizeBytes,
            sha256: body.sha256,
            now,
          },
          s3,
        );
      });
      return reply.code(200).send({
        artifactId: slot.artifactId,
        method: "PUT",
        url: slot.url,
        headers: slot.headers,
        expiresAt: slot.expiresAt.toISOString(),
      });
    });

    route("internalComplete", async (request, reply) => {
      const scope = runScope(request);
      const body = parseBody(completeRequestSchema, request.body);
      // Exactly one of the two shapes the contract publishes. Neither = the worker told us
      // nothing, and defaulting that to a verdict would invent a result nobody measured.
      if (body.verdict === undefined && body.infraError === null) {
        throw new ValidationFailedError("A complete needs either a verdict or an infraError.", [
          "verdict: required unless infraError is present",
        ]);
      }
      assertEpochMatchesToken(body.leaseEpoch, scope);
      const ctx: TenantContext = { teamId: scope.teamId };
      const now = new Date();
      const finished = await withTenant(db, ctx, async (tx) => {
        // ONE transaction for the whole report. The fence is first, so a zombie's results are
        // never written at all; and because everything below shares this transaction, a stale
        // outcome from completeJob would roll the rows back too.
        const fenced = unwrap(await fenceJob(tx, ctx, { jobRunId: scope.jobRunId, epoch: body.leaseEpoch }));
        await writeCaseResults(tx, ctx, {
          runId: fenced.runId,
          jobRunId: scope.jobRunId,
          attempt: fenced.attempt,
          cases: toCaseResults(body.steps, fenced.chainKey, now),
        });
        const outcome = unwrap(
          await completeJob(tx, ctx, {
            jobRunId: scope.jobRunId,
            epoch: body.leaseEpoch,
            // The queue reads `verdict` only when `infra` is null; "failed" is the honest
            // filler for the infra branch, which decides requeue-or-fail on its own.
            verdict: body.verdict ?? "failed",
            infra:
              body.infraError === null
                ? null
                : { code: body.infraError.code, message: body.infraError.message },
            now,
          }),
        );
        // Which blobs actually landed. Matched by digest, scoped to this attempt — a digest we
        // never signed a URL for matches nothing.
        await markArtifactsUploaded(tx, ctx, {
          jobRunId: scope.jobRunId,
          attempt: fenced.attempt,
          sha256s: body.artifacts.map((a) => a.sha256),
        });
        if (outcome.requeued) {
          // Ownership moved to the NEXT attempt, so this credential dies with the lease it was
          // minted for: the worker's next call is 401 rather than a confusing 409.
          //
          // Deliberately NOT done on the terminal path, even though the plan's handler table
          // revoked unconditionally: `complete` is delivered at least once, so a worker whose
          // response was lost WILL send it again. With the token alive that retry reads 410
          // JOB_TERMINAL ("this job already ended, drop it"); with the token revoked it would
          // read 401, which tells the worker to exit and re-register over a job that finished
          // perfectly. The token expires with its own TTL a minute later either way, and every
          // endpoint answers 410 for a finished job in the meantime, so nothing is gained by
          // killing it early.
          await revokeRunTokensFor(tx, ctx, scope.jobRunId);
        }
        return outcome;
      });
      return reply
        .code(200)
        .send({ ok: true, requeued: finished.requeued, attempt: finished.attempt });
    });
  };
}
