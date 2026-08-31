/**
 * THE ONLY FILE THAT KNOWS THE CONTROL PLANE'S SHAPE.
 *
 * CONTRACT SYNC: this client is the client side of `packages/contract/src/routes/internal.ts`,
 * which the M3 orchestration plan owns and `apps/core/src/http/internal/routes.ts` serves. It
 * does not re-declare one payload: paths come from `INTERNAL_ROUTES`, bodies are built with the
 * contract's own zod schemas, and answers are parsed back with them. A field renamed over there
 * therefore breaks THIS BUILD instead of a production run, and any real divergence is fixed here
 * and in `test/harness/fake-control-plane.ts` — nowhere else in the worker.
 *
 * ZERO-CREDENTIAL (docs/SYSTEM_DESIGN.md §5). Three tokens exist in the fleet and this process
 * ever holds two of them: the host's BOOTSTRAP token, used once to register, and a per-run token
 * that arrives with a claim and dies with the lease. There is no database url here, no
 * object-store key, no team secret — an artifact is written to a URL the control plane signed.
 *
 * EPOCH IS NOT OPTIONAL. Every job mutation carries `leaseEpoch`. A `409 STALE_EPOCH` means this
 * worker is a ZOMBIE: its lease was reaped and another attempt owns the chain now. It raises
 * StaleEpochError and is NEVER retried — retrying is precisely how a zombie corrupts a result
 * another worker already wrote.
 *
 * ERRORS ARE THE CONTRACT'S OWN CLASSES. Each answer is turned back into the error the server
 * raised (`UnauthorizedError`, `NotFoundError`, `StaleEpochError`, `JobCancelledError`,
 * `JobTerminalError`, `ValidationFailedError`), so the worker loop branches on classes rather
 * than on status numbers, and every one of them is an `AppError` with `retryable === false` —
 * the single predicate that gates retries repo-wide sees them and stops.
 *
 * WHAT IS PROVEN WHERE. `test/control-plane-client.test.ts` drives this class over a real socket
 * against a FAKE plane that validates with the contract's schemas: it proves the worker SPEAKS
 * the contract. It cannot prove the far end agrees — lease reaping, claim concurrency, run-token
 * TTL and real presigned signatures are proven by `apps/core`'s suites and, end to end, only by
 * the M3 acceptance soak against a real control plane.
 *
 * DEVIATIONS from the fleet plan's Task 15 code block, each forced by the settled contract:
 *  1. `register` takes `{ workerId, hostname, lane, capacity }` and answers
 *     `{ workerId, lane, workerToken, heartbeatIntervalMs, drain }` — not the plan's
 *     `{ workerName, maxContexts }` / `{ workerId, workerToken }`.
 *  2. `claim` and `workerHeartbeat` take NO workerId or lane. Both are read from the
 *     registration answer, because the roster row — not the worker's own opinion — is the
 *     authority: the real plane answers 401 when a body disagrees with its token, and a 401
 *     makes the worker exit and re-register over what was never a credential problem. A client
 *     that does not accept those values cannot produce that disagreement.
 *  3. The event vocabulary is the closed 7-value `RUN_EVENT_KIND_VALUES` (the plan listed two),
 *     the artifact vocabulary the closed 5-value `ARTIFACT_KIND_VALUES`, and both are checked
 *     HERE, before a socket is opened, together with the `sizeBytes` ceiling and the sha-256
 *     shape. A 400 from the ticket endpoint costs a failed chain its evidence.
 *  4. `complete` carries the four presentation fields per step (`renderedSentence`,
 *     `failureContext`, `screenshotArtifactId`, `thumbhash`). The contract defaults them, so
 *     omitting them is not an error — it is a silent hole where the per-step gallery and its
 *     ThumbHash placeholders should be (docs/SYSTEM_DESIGN.md §5.2), which is why they are
 *     carried through as ordinary fields of a step rather than as an optional extra.
 *  5. 410 is two codes, and they are told apart: JOB_CANCELLED (the run was cancelled mid-chain)
 *     and JOB_TERMINAL (this job already finished — the answer a redelivered `complete` gets).
 *     Both mean "stop writing about this job"; only one of them is worth alarming about.
 *  6. `event`, `complete`, `fail` and `jobHeartbeat` return their acknowledgements instead of
 *     `void`: `duplicate`, `requeued`, `attempt` and the renewed `leaseDeadlineAt` are what the
 *     worker loop needs to know it is not talking to itself.
 */
import {
  claimRequestSchema,
  claimedJobSchema,
  completeRequestSchema,
  completeResponseSchema,
  eventRequestSchema,
  eventResponseSchema,
  FatalInfraError,
  INTERNAL_ROUTES,
  JobCancelledError as ContractJobCancelledError,
  JobTerminalError as ContractJobTerminalError,
  NotFoundError,
  RetryableInfraError,
  RUN_EVENT_KIND_VALUES,
  StaleEpochError as ContractStaleEpochError,
  UnauthorizedError,
  ValidationFailedError,
  artifactRequestSchema,
  artifactResponseSchema,
  jobHeartbeatRequestSchema,
  jobHeartbeatResponseSchema,
  registerRequestSchema,
  registerResponseSchema,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  // Read only through `z.input<typeof …>`: value imports because `typeof` needs the binding.
  completedArtifactSchema,
  completedStepSchema,
  infraErrorSchema,
} from "@testkite/contract";
import { PLAN_FORMAT_VERSION, type RunPlan } from "@testkite/run-compiler";
import type { z } from "zod";
import type { PresignedTarget } from "./artifacts/uploader.js";

/**
 * The worker was fenced: its lease epoch is not the one the control plane holds. Subclasses the
 * contract's own 409 so the retry predicate (`AppError && retryable`) sees `false` and the code
 * stays `STALE_EPOCH` in every log line; adds the three facts a zombie may know about itself.
 */
export class StaleEpochError extends ContractStaleEpochError {
  readonly jobRunId: string;
  readonly sentEpoch: number;
  constructor(jobRunId: string, sentEpoch: number, currentEpoch: number, detail: string) {
    super(`STALE_EPOCH on job ${jobRunId}: sent epoch ${sentEpoch}, plane holds ${currentEpoch} — ${detail}`, currentEpoch);
    this.name = "StaleEpochError";
    this.jobRunId = jobRunId;
    this.sentEpoch = sentEpoch;
  }
}

/** 410 JOB_CANCELLED — the run was cancelled while the chain was running. Abandon, never complete. */
export class JobCancelledError extends ContractJobCancelledError {
  readonly jobRunId: string;
  constructor(jobRunId: string, detail: string) {
    super(`job ${jobRunId} was cancelled by the control plane — ${detail}`);
    this.name = "JobCancelledError";
    this.jobRunId = jobRunId;
  }
}

/**
 * 410 JOB_TERMINAL — the job already ended. Normal, not alarming: `complete` is delivered at
 * least once, so a worker whose answer was lost sends it again and gets this.
 */
export class JobTerminalError extends ContractJobTerminalError {
  readonly jobRunId: string;
  constructor(jobRunId: string, detail: string) {
    super(`job ${jobRunId} has already finished — ${detail}`);
    this.name = "JobTerminalError";
    this.jobRunId = jobRunId;
  }
}

/** The closed vocabulary of run events. Derived from the contract, never re-typed. */
export type RunEventKind = (typeof RUN_EVENT_KIND_VALUES)[number];

export type RegisterRequest = z.input<typeof registerRequestSchema>;
export type RegisterResponse = z.infer<typeof registerResponseSchema>;
export type WorkerHeartbeatRequest = z.input<typeof workerHeartbeatRequestSchema>;
export type WorkerHeartbeatResponse = z.infer<typeof workerHeartbeatResponseSchema>;
export type JobHeartbeatResponse = z.infer<typeof jobHeartbeatResponseSchema>;
export type EventAck = z.infer<typeof eventResponseSchema>;
export type CompleteAck = z.infer<typeof completeResponseSchema>;
/** One executed step, FLAT (it carries its own caseId); the plane groups by case when writing. */
export type CompletedStep = z.input<typeof completedStepSchema>;
export type CompletedArtifact = z.input<typeof completedArtifactSchema>;
export type InfraPayload = z.input<typeof infraErrorSchema>;

/** A claimed job: exactly the contract's shape, with the frozen plan typed once it is checked. */
export interface ClaimedJob {
  readonly jobRunId: string;
  readonly runId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseDeadlineAt: string;
  /** Scoped to THIS run and dead with the lease; the only credential for a job mutation. */
  readonly runToken: string;
  readonly plan: RunPlan;
}

export interface RunEventReport {
  /** Monotonic per job — the plane deduplicates on it, so a resend is harmless, never a 409. */
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ArtifactTicketRequest {
  readonly kind: CompletedArtifact["kind"];
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** A presigned PUT plus the id the step gallery links a screenshot to. */
export interface ArtifactTicket extends PresignedTarget {
  readonly artifactId: string;
  readonly expiresAt: string;
}

export interface CompletePayload {
  readonly verdict: "passed" | "failed" | "aborted_early" | "cancelled";
  readonly steps: readonly CompletedStep[];
  readonly artifacts: readonly CompletedArtifact[];
}

export interface ControlPlaneClient {
  register(req: RegisterRequest): Promise<RegisterResponse>;
  workerHeartbeat(req: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse>;
  claim(req: { readonly freeSlots: number }): Promise<ClaimedJob | null>;
  jobHeartbeat(job: ClaimedJob): Promise<JobHeartbeatResponse>;
  event(job: ClaimedJob, event: RunEventReport): Promise<EventAck>;
  artifactTicket(job: ClaimedJob, req: ArtifactTicketRequest): Promise<ArtifactTicket>;
  complete(job: ClaimedJob, payload: CompletePayload): Promise<CompleteAck>;
  fail(job: ClaimedJob, infra: InfraPayload): Promise<CompleteAck>;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly bootstrapToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The ceiling on an obeyed `Retry-After`. A lease is 30s; waiting longer than that turns a
 * throttled worker into a fenced one, so a header asking for more is honoured only up to the
 * point where the job would be reaped anyway.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Resolved at module load, from the contract's own route table: a route the contract stops
 * publishing takes the worker down at BOOT with a named cause, instead of at the first claim
 * with a 404 that reads like a missing job.
 */
function pathTemplate(operationId: string): string {
  const descriptor = INTERNAL_ROUTES.find((route) => route.operationId === operationId);
  if (descriptor === undefined) {
    throw new FatalInfraError(`INTERNAL_ROUTES no longer publishes ${operationId} — this worker cannot talk to that control plane`);
  }
  return descriptor.path;
}

const REGISTER_PATH = pathTemplate("internalRegister");
const WORKER_HEARTBEAT_PATH = pathTemplate("internalWorkerHeartbeat");
const CLAIM_PATH = pathTemplate("internalClaim");
const JOB_HEARTBEAT_PATH = pathTemplate("internalJobHeartbeat");
const EVENTS_PATH = pathTemplate("internalEvents");
const ARTIFACTS_PATH = pathTemplate("internalArtifacts");
const COMPLETE_PATH = pathTemplate("internalComplete");

function fillPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new FatalInfraError(`no value for path parameter ${name} of ${template}`);
    return encodeURIComponent(value);
  });
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * Builds an outgoing body with the CONTRACT'S schema, so every closed vocabulary, every size
 * ceiling and every digest shape is enforced before a socket is opened — and so the defaults the
 * contract declares travel explicitly on the wire. A failure here is a bug in this worker, never
 * a transient condition: `FatalInfraError`, never retried.
 */
function encodeBody<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FatalInfraError(`the worker built a ${what} request the contract rejects: ${issuesOf(parsed.error)}`);
  }
  return parsed.data as z.infer<S>;
}

/**
 * Parses an answer with the contract's schema. A body that does not fit is a control plane
 * speaking a different version of this contract; trying the same call again cannot fix that.
 */
function decodeBody<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new FatalInfraError(`the control plane answered ${what} with a body this contract cannot read: ${issuesOf(parsed.error)}`);
  }
  return parsed.data as z.infer<S>;
}

/**
 * The frozen plan crosses the wire as `unknown` (the contract package must not import the
 * compiler). Two things are checked before it is trusted as a `RunPlan`, and the FORMAT VERSION
 * is the one that matters: a plane upgraded past this worker would otherwise hand it a plan
 * whose steps mean something else, and executing that is worse than refusing the job.
 *
 * `contentHash` is deliberately NOT recomputed here: it is the hash of the canonical JSON the
 * control plane froze and stores as jsonb, so re-deriving it in the worker would make every run
 * in the fleet hostage to a storage-level normalisation, for a guarantee the authenticated
 * channel already provides.
 */
function asRunPlan(value: unknown, jobRunId: string): RunPlan {
  if (typeof value !== "object" || value === null) {
    throw new FatalInfraError(`job ${jobRunId} arrived without a frozen plan`);
  }
  const candidate = value as { planFormatVersion?: unknown; chains?: unknown; contentHash?: unknown };
  if (candidate.planFormatVersion !== PLAN_FORMAT_VERSION) {
    throw new FatalInfraError(
      `job ${jobRunId} carries plan format ${String(candidate.planFormatVersion)}, and this worker implements ${String(PLAN_FORMAT_VERSION)} — refusing to run a plan it may read wrongly`,
    );
  }
  if (!Array.isArray(candidate.chains) || typeof candidate.contentHash !== "string") {
    throw new FatalInfraError(`job ${jobRunId} carries a plan without chains or content hash`);
  }
  // The only cast in this file, and it stands on the three checks above.
  return value as RunPlan;
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly currentEpoch: number | null;
  readonly issues: readonly string[];
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  const raw: unknown = await response.json().catch(() => ({}));
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as {
    code?: unknown;
    message?: unknown;
    currentEpoch?: unknown;
    issues?: unknown;
  };
  return {
    code: typeof body.code === "string" ? body.code : "",
    message: typeof body.message === "string" ? body.message : `http ${response.status}`,
    currentEpoch: typeof body.currentEpoch === "number" ? body.currentEpoch : null,
    issues: Array.isArray(body.issues) ? body.issues.map((issue) => String(issue)) : [],
  };
}

/**
 * `Retry-After` in whole seconds — the only form this plane sends (`TooManyRequestsError`), and
 * the standard header rather than a private body field, which is why it is read at all.
 */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

/** Exponential, with jitter: a fleet that backs off in lockstep is a fleet that retries in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(4_000, 200 * 2 ** (attempt - 1));
  return base + Math.floor(base * 0.2 * Math.random());
}

/**
 * `fetch` wrapped rather than passed by reference: detached from `globalThis` it misbehaves in
 * some runtimes, and the default path is the one no test covers.
 */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export class HttpControlPlaneClient implements ControlPlaneClient {
  readonly #baseUrl: string;
  readonly #bootstrapToken: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** What the roster answered at register time. The worker's own opinion is never sent. */
  #registration: { readonly workerId: string; readonly lane: "interactive" | "batch"; readonly workerToken: string } | null = null;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#bootstrapToken = options.bootstrapToken;
    this.#fetch = options.fetchImpl ?? defaultFetch;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const body = encodeBody(registerRequestSchema, req, "register");
    const answer = decodeBody(
      registerResponseSchema,
      await this.#post(REGISTER_PATH, body, this.#bootstrapToken, null),
      "register",
    );
    this.#registration = { workerId: answer.workerId, lane: answer.lane, workerToken: answer.workerToken };
    return answer;
  }

  async workerHeartbeat(req: WorkerHeartbeatRequest): Promise<WorkerHeartbeatResponse> {
    const registration = this.#requireRegistration("worker heartbeat");
    const body = encodeBody(workerHeartbeatRequestSchema, req, "worker heartbeat");
    const path = fillPath(WORKER_HEARTBEAT_PATH, { workerId: registration.workerId });
    return decodeBody(
      workerHeartbeatResponseSchema,
      await this.#post(path, body, registration.workerToken, null),
      "worker heartbeat",
    );
  }

  async claim(req: { readonly freeSlots: number }): Promise<ClaimedJob | null> {
    const registration = this.#requireRegistration("claim");
    const body = encodeBody(
      claimRequestSchema,
      { workerId: registration.workerId, lane: registration.lane, freeSlots: req.freeSlots },
      "claim",
    );
    const answer = await this.#post(CLAIM_PATH, body, registration.workerToken, null);
    // 204: an empty queue is the normal answer, not an error. Sleep `claimIdleMs`, ask again.
    if (answer === null) return null;
    const claimed = decodeBody(claimedJobSchema, answer, "claim");
    return {
      jobRunId: claimed.jobRunId,
      runId: claimed.runId,
      teamId: claimed.teamId,
      projectId: claimed.projectId,
      chainKey: claimed.chainKey,
      attempt: claimed.attempt,
      leaseEpoch: claimed.leaseEpoch,
      leaseDeadlineAt: claimed.leaseDeadlineAt,
      runToken: claimed.runToken,
      plan: asRunPlan(claimed.plan, claimed.jobRunId),
    };
  }

  async jobHeartbeat(job: ClaimedJob): Promise<JobHeartbeatResponse> {
    const body = encodeBody(jobHeartbeatRequestSchema, { leaseEpoch: job.leaseEpoch }, "job heartbeat");
    const path = fillPath(JOB_HEARTBEAT_PATH, { jobRunId: job.jobRunId });
    return decodeBody(jobHeartbeatResponseSchema, await this.#post(path, body, job.runToken, job), "job heartbeat");
  }

  async event(job: ClaimedJob, event: RunEventReport): Promise<EventAck> {
    const body = encodeBody(
      eventRequestSchema,
      { leaseEpoch: job.leaseEpoch, seq: event.seq, kind: event.kind, payload: event.payload ?? {} },
      "event",
    );
    const path = fillPath(EVENTS_PATH, { jobRunId: job.jobRunId });
    return decodeBody(eventResponseSchema, await this.#post(path, body, job.runToken, job), "event");
  }

  async artifactTicket(job: ClaimedJob, req: ArtifactTicketRequest): Promise<ArtifactTicket> {
    // The ceiling, the digest shape and the five kinds are all in this one parse: the plane
    // refuses to SIGN what it would reject, so asking is how a failed chain loses its evidence.
    const body = encodeBody(
      artifactRequestSchema,
      { leaseEpoch: job.leaseEpoch, kind: req.kind, contentType: req.contentType, sha256: req.sha256, sizeBytes: req.sizeBytes },
      "artifact ticket",
    );
    const path = fillPath(ARTIFACTS_PATH, { jobRunId: job.jobRunId });
    const answer = decodeBody(artifactResponseSchema, await this.#post(path, body, job.runToken, job), "artifact ticket");
    return {
      artifactId: answer.artifactId,
      url: answer.url,
      method: answer.method,
      headers: answer.headers,
      expiresAt: answer.expiresAt,
    };
  }

  async complete(job: ClaimedJob, payload: CompletePayload): Promise<CompleteAck> {
    const body = encodeBody(
      completeRequestSchema,
      { leaseEpoch: job.leaseEpoch, verdict: payload.verdict, steps: payload.steps, artifacts: payload.artifacts },
      "complete",
    );
    const path = fillPath(COMPLETE_PATH, { jobRunId: job.jobRunId });
    return decodeBody(completeResponseSchema, await this.#post(path, body, job.runToken, job), "complete");
  }

  /**
   * An infra failure is NOT a verdict: it goes to the same endpoint with `infraError` and no
   * verdict at all, and the plane decides requeue-or-fail from `retryable`. Partial steps are
   * deliberately not reported — the attempt is being handed back, and the next attempt writes
   * the authoritative rows.
   */
  async fail(job: ClaimedJob, infra: InfraPayload): Promise<CompleteAck> {
    const body = encodeBody(completeRequestSchema, { leaseEpoch: job.leaseEpoch, infraError: infra }, "infra failure");
    const path = fillPath(COMPLETE_PATH, { jobRunId: job.jobRunId });
    return decodeBody(completeResponseSchema, await this.#post(path, body, job.runToken, job), "infra failure");
  }

  #requireRegistration(what: string): { readonly workerId: string; readonly lane: "interactive" | "batch"; readonly workerToken: string } {
    const registration = this.#registration;
    if (registration === null) {
      throw new FatalInfraError(`the worker tried to ${what} before registering — there is no worker token and no roster row yet`);
    }
    return registration;
  }

  /** Returns the parsed body, or `null` for the one endpoint that answers 204. */
  async #post(path: string, body: unknown, token: string, job: ClaimedJob | null): Promise<unknown> {
    let lastError = "";
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.#maxAttempts) await this.#sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 204) return null;
      if (response.ok) return (await response.json().catch(() => ({}))) as unknown;

      const error = await readErrorBody(response);
      // Everything below 500, except the two that describe a moment rather than the request,
      // is permanent: the same bytes sent again get the same answer.
      if (response.status !== 429 && response.status < 500) throw this.#permanent(response.status, error, path, job);

      const wait = response.status === 429 ? retryAfterMs(response) : null;
      lastError = `http ${response.status}`;
      if (attempt < this.#maxAttempts) await this.#sleep(wait ?? backoffMs(attempt));
    }
    throw new RetryableInfraError(
      "network",
      `control plane unreachable for ${path} after ${this.#maxAttempts} attempts: ${lastError}`,
    );
  }

  /** One place turns a permanent answer back into the error the control plane raised. */
  #permanent(status: number, error: ErrorBody, path: string, job: ClaimedJob | null): Error {
    if (status === 409 && error.code === "STALE_EPOCH") {
      if (job === null) {
        return new FatalInfraError(`control plane answered STALE_EPOCH on ${path}, which carries no job — ${error.message}`);
      }
      // A zombie MUST NOT retry: another attempt owns this chain and may already have written.
      return new StaleEpochError(job.jobRunId, job.leaseEpoch, error.currentEpoch ?? -1, error.message);
    }
    if (status === 410) {
      const jobRunId = job?.jobRunId ?? "unknown";
      return error.code === "JOB_CANCELLED"
        ? new JobCancelledError(jobRunId, error.message)
        : new JobTerminalError(jobRunId, error.message);
    }
    // 401 is a credential problem: the worker exits and systemd's restart re-registers it.
    if (status === 401) return new UnauthorizedError(`control plane rejected this worker's credential on ${path}`);
    // 404 is not: the job is gone, so the worker drops it and keeps claiming.
    if (status === 404) return new NotFoundError(`control plane has no such job for ${path}`);
    if (status === 400) return new ValidationFailedError(`control plane rejected the body of ${path}: ${error.message}`, error.issues);
    return new FatalInfraError(`control plane rejected ${path} with ${status} ${error.code}: ${error.message}`);
  }
}
