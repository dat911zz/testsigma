/**
 * The worker's whole life: claim → run one chain → report. Everything difficult about the fleet
 * is expressed here as ORDERING, not cleverness.
 *
 *  - SHED BEFORE CLAIMING. Admission control that runs after a job is in hand is not admission
 *    control. Above 75% of the container ceiling this worker stops taking work (§5).
 *  - FENCE BEFORE OPENING A BROWSER. `chain_started` is the one event that is AWAITED: it costs a
 *    round trip and buys the guarantee that a worker whose lease was already reaped never opens a
 *    context at all. Per-step events stay fire-and-forget, because a slow control plane must not
 *    pace the browser.
 *  - EPOCH ON EVERY MUTATION; 409 STALE_EPOCH IS A FULL STOP. The worker writes NOTHING more for
 *    that job — no event, no artifact, no verdict — because another attempt owns the chain and may
 *    already have written it. It also CLOSES THE RUNNING CONTEXT immediately: the 2026-08-29 spike
 *    measured that a lost `Promise.race` leaves a Playwright action running and only closing the
 *    context truly cancels it, so "stop" has to mean close, not merely "stop awaiting". Then the
 *    worker refuses to claim again: being fenced is a fact about this process, not about this job.
 *  - THE LEASE IS RENEWED WHILE THE CHAIN RUNS. A lease outlives a claim by seconds and a chain by
 *    minutes; without `jobHeartbeat` every long chain would reap its own lease and manufacture the
 *    zombie this file exists to make harmless. The heartbeat is also the channel that carries
 *    `cancel` and `drain` back to a worker that is deep inside a chain.
 *  - AssertionFailure COMPLETES the job with verdict=failed. Only an infra error goes to fail().
 *  - After any infra failure, ask the cgroup whether the kernel actually killed chromium: if it
 *    did, the report is upgraded to browser_oom with the real peakRss, and the chain's OOM counter
 *    moves toward quarantine — at which point the report goes back NOT retryable, which is how a
 *    poison chain stops being requeued forever.
 *
 * SCOPE — what CI proves here and what it cannot. `test/worker.test.ts` drives this class against a
 * stub control plane, `FakeBrowserEngine` and `FakeMemoryLimiter`, so it proves ORDER and PAYLOAD
 * SHAPE and nothing else: on the fake, `close()` flips a boolean and cancels no action, and
 * `raiseOomKill()` is a counter, not a kernel. That closing a real context cancels the action
 * behind it is `test/browser/playwright-engine.test.ts` (real chromium); that a nested cgroup
 * really kills chromium and leaves node alive is `test/host/cgroup-v2.test.ts` (`test:host`); that
 * the far end accepts these bodies is `apps/core`'s internal-plane suites and the M3 acceptance
 * soak. Every payload is still built by the CONTRACT'S OWN schemas inside `control-plane-client.ts`,
 * so a shape this worker cannot legally express fails at compile time rather than in production.
 */
import { infraErrorSchema, UnauthorizedError } from "@testkite/contract";
import type { ChainPlan, ScreenshotPolicy } from "@testkite/run-compiler";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactUploader } from "./artifacts/uploader.js";
import { presignRejection, SCREENSHOT_CONTENT_TYPE, type ScreenshotRing } from "./artifacts/screenshot-ring.js";
import type { BrowserEngine, EngineContextHandle } from "./browser/engine.js";
import {
  JobCancelledError,
  JobTerminalError,
  StaleEpochError,
  type ClaimedJob,
  type CompletedArtifact,
  type CompletedStep,
  type CompletePayload,
  type ControlPlaneClient,
  type InfraPayload,
} from "./control-plane-client.js";
import { runChain, type ChainOutcome, type StepOutcome, type VerbResolver } from "./executor/run-chain.js";
import type { ContextMemoryMonitor } from "./memory/context-monitor.js";
import type { OomReporter } from "./memory/oom-reporter.js";
import { planShedding } from "./memory/shedder.js";
import type { QuarantineDecider } from "./quarantine.js";

/**
 * ONE. This class executes a single chain at a time, so telling the plane anything else would
 * overstate the fleet's capacity by exactly the number of worker processes per container. The
 * lane's K (`MEMORY.contextsPerWorker`) is delivered by running that many `ts-worker@` instances
 * (Task 18), each of which is one of these — not by one worker juggling K chains.
 */
const FREE_SLOTS_PER_WORKER = 1;

/** The trace is a zip; the ticket endpoint signs one content type and the PUT must send the same. */
const TRACE_CONTENT_TYPE = "application/zip";

/**
 * The five codes and the message ceiling are READ OFF the contract's schema rather than retyped:
 * the executor's taxonomy is open (any `AppError.code` can arrive), the wire's is closed, and this
 * is the one place the two meet.
 */
const CONTRACT_INFRA_CODES: readonly InfraPayload["code"][] = infraErrorSchema.shape.code.options;
const INFRA_MESSAGE_MAX = infraErrorSchema.shape.message.maxLength ?? 2048;

export type RunOnceResult = "idle" | "ran" | "shed" | "stopped";

export interface WorkerDeps {
  readonly client: ControlPlaneClient;
  readonly engine: BrowserEngine;
  /**
   * One ring per JOB, not per chain key: the ring is content-addressed, so two rings sharing a
   * directory delete each other's blobs. `scratchKey` is the jobRunId — unique, and already
   * path-safe because the contract types it as a uuid.
   */
  readonly ring: (scratchKey: string, policy: ScreenshotPolicy) => ScreenshotRing;
  readonly uploader: ArtifactUploader;
  readonly quarantine: QuarantineDecider;
  readonly oom: OomReporter;
  readonly monitor: ContextMemoryMonitor;
  /**
   * Publishes the chain's live context (and `null` when it is gone) so the L3 monitor can sample
   * THIS context's renderer pids. Without it `sampleRss` has nothing to read and the 350/500MB
   * ceiling is inert — governance that exists only as a constant.
   */
  readonly onChainContext: (handle: EngineContextHandle | null) => void;
  readonly resolveVerb: VerbResolver;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly workerId: string;
  readonly lane: "interactive" | "batch";
  readonly maxContexts: number;
  readonly containerLimitBytes: number;
  /** Where a retained trace.zip is written before it is uploaded. NVMe scratch, never tmpfs. */
  readonly traceDir: string;
  /** Lease renewal period. Must stay well under the plane's lease TTL, or the worker fences itself. */
  readonly jobHeartbeatMs: number;
}

export interface WorkerStats {
  readonly claimed: number;
  readonly completed: number;
  readonly infraFailures: number;
  readonly zombieSuicides: number;
  readonly quarantined: number;
}

/**
 * What the plane said about a job that is no longer this worker's to write about.
 *
 * `UnauthorizedError` (a 401) belongs here for the same reason a 409 does: the plane is refusing
 * to hear from this worker at all, so the chain must stop driving a browser on the tenant's system
 * — the lease it was renewing is being reaped, and another attempt will run the same chain, with
 * duplicate side effects against the tenant's app if this one keeps going. It differs from the
 * others only in what happens after: `runOnce` re-throws it, `main()` exits, and systemd's restart
 * re-registers the worker with a fresh credential.
 */
type Fence = StaleEpochError | JobCancelledError | JobTerminalError | UnauthorizedError;

/**
 * Holds the one context a chain is allowed to open, so the worker can CLOSE it from outside the
 * executor — the only cancellation Playwright has. `runChain` still closes it in `finally`; both
 * closes are safe because `EngineContextHandle.close()` is idempotent.
 */
interface ChainContextGuard {
  readonly engine: BrowserEngine;
  handle(): EngineContextHandle | null;
  abort(): void;
}

function guardChainContext(inner: BrowserEngine, onOpen: (handle: EngineContextHandle) => void): ChainContextGuard {
  let open: EngineContextHandle | null = null;
  const engine: BrowserEngine = {
    kind: inner.kind,
    newChainContext: async (options) => {
      const handle = await inner.newChainContext(options);
      open = handle;
      onOpen(handle);
      return handle;
    },
    browserPid: () => inner.browserPid(),
    contextsServed: () => inner.contextsServed(),
    treeRssBytes: () => inner.treeRssBytes(),
    crashed: () => inner.crashed(),
    close: () => inner.close(),
  };
  return {
    engine,
    handle: () => open,
    abort: () => {
      const handle = open;
      if (handle === null) return;
      // Deliberately not awaited: this is called from an event-delivery catch, and the point is
      // that the browser stops NOW rather than at the next await in the chain.
      void handle.close().catch(() => undefined);
    },
  };
}

function isContractInfraCode(code: string): code is InfraPayload["code"] {
  return CONTRACT_INFRA_CODES.some((known) => known === code);
}

function boundedMessage(message: string): string {
  return message.length <= INFRA_MESSAGE_MAX ? message : message.slice(0, INFRA_MESSAGE_MAX);
}

/**
 * The executor's error taxonomy is open (`classifyError` passes any `AppError.code` through, plus
 * `fatal_infra` for a bare throw); the wire's is the closed five. An unknown code is reported as
 * `context_crash` — the honest neighbour, "this chain's execution environment broke" — with the
 * real code kept in the message, because the alternative is `encodeBody` rejecting the report and
 * the worker dying with the job still leased. Widening the enum is a contract change and belongs
 * to the orchestration plan, not here.
 */
function toContractInfra(infra: ChainOutcome["infra"]): InfraPayload {
  if (infra === undefined) {
    return {
      code: "context_crash",
      retryable: false,
      message: "the chain ended in an infra error the executor did not describe",
    };
  }
  if (isContractInfraCode(infra.code)) {
    return { code: infra.code, retryable: infra.retryable, message: boundedMessage(infra.message) };
  }
  return {
    code: "context_crash",
    retryable: infra.retryable,
    message: boundedMessage(`[${infra.code}] ${infra.message}`),
  };
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

interface UploadedEvidence {
  readonly artifacts: readonly CompletedArtifact[];
  /** sha256 → artifactId, so a step can link the exact frame it produced. */
  readonly artifactIdBySha: ReadonlyMap<string, string>;
}

const NO_EVIDENCE: UploadedEvidence = { artifacts: [], artifactIdBySha: new Map() };

/**
 * The verdict this job COMPLETES with, or null when there is no verdict to write because the
 * chain died of an infra cause. A cancel that arrived mid-chain wins over whatever the aborted
 * chain looked like from the inside: closing the context under a running action reads as a crash,
 * and reporting that as an infra failure would have the plane requeue a run the tenant cancelled.
 */
function settledVerdict(chainVerdict: ChainOutcome["verdict"], cancelled: boolean): CompletePayload["verdict"] | null {
  if (cancelled) return "cancelled";
  return chainVerdict === "infra_error" ? null : chainVerdict;
}

export class Worker {
  readonly #deps: WorkerDeps;
  #draining = false;
  #claimed = 0;
  #completed = 0;
  #infraFailures = 0;
  #zombieSuicides = 0;
  #quarantined = 0;
  /** Set the instant the plane says this job is not ours; every write checks it before speaking. */
  #fence: Fence | null = null;
  /** The plane asked for a graceful cancel — unlike a fence, this one still reports a verdict. */
  #cancelled = false;
  /** The job every asynchronous answer is checked against; null between jobs. */
  #currentJobRunId: string | null = null;

  constructor(deps: WorkerDeps) {
    this.#deps = deps;
  }

  requestDrain(): void {
    this.#draining = true;
  }

  stats(): WorkerStats {
    return {
      claimed: this.#claimed,
      completed: this.#completed,
      infraFailures: this.#infraFailures,
      zombieSuicides: this.#zombieSuicides,
      quarantined: this.#quarantined,
    };
  }

  async runOnce(): Promise<RunOnceResult> {
    if (this.#draining) return "stopped";

    const shed = planShedding(this.#deps.engine.treeRssBytes(), this.#deps.containerLimitBytes, []);
    if (!shed.admit) {
      this.#deps.log(`shedding at level ${shed.level}: not claiming (worker context ceiling ${this.#deps.maxContexts})`);
      return "shed";
    }

    const job = await this.#deps.client.claim({ freeSlots: FREE_SLOTS_PER_WORKER });
    if (job === null) return "idle";
    this.#claimed += 1;
    this.#fence = null;
    this.#cancelled = false;

    try {
      await this.#runJob(job);
      return "ran";
    } catch (err) {
      if (err instanceof StaleEpochError) {
        // ZOMBIE SUICIDE: stop dead. Not one more byte for this job — and no further claims,
        // because a reaped lease says something about this PROCESS, not just this chain.
        this.#zombieSuicides += 1;
        this.#draining = true;
        this.#deps.log(`stale epoch on job ${job.jobRunId}: this worker is a zombie, dropping everything`);
        return "stopped";
      }
      if (err instanceof JobCancelledError || err instanceof JobTerminalError) {
        // Both mean "this job is over and it is not yours to write about". A JOB_TERMINAL is the
        // ordinary answer to a redelivered `complete`, so it must not take the worker down.
        this.#deps.log(`job ${job.jobRunId} is no longer writable: ${err.message}`);
        return "ran";
      }
      throw err;
    }
  }

  async #runJob(job: ClaimedJob): Promise<void> {
    const chain = job.plan.chains.find((candidate) => candidate.chainKey === job.chainKey);
    if (chain === undefined) {
      // Not retryable: the frozen plan is what it is, and another attempt reads the same bytes.
      await this.#deps.client.fail(job, {
        code: "context_crash",
        retryable: false,
        message: boundedMessage(
          `the claimed plan carries no chain "${job.chainKey}" — this worker and the control plane disagree about the frozen plan`,
        ),
      });
      this.#infraFailures += 1;
      return;
    }

    let seq = 0;
    const nextSeq = (): number => {
      seq += 1;
      return seq;
    };

    // Every asynchronous answer is stamped with the job it is about. A `jobHeartbeat` or an event
    // POST issued for job N-1 can still reject after that job ended, and acting on it would fence
    // a perfectly healthy worker over a lease it no longer holds anyway.
    this.#currentJobRunId = job.jobRunId;
    try {
      await this.#runChainOfJob(job, chain, nextSeq);
    } finally {
      this.#currentJobRunId = null;
    }
  }

  async #runChainOfJob(job: ClaimedJob, chain: ChainPlan, nextSeq: () => number): Promise<void> {
    // AWAITED on purpose: this is the fence. A reaped worker learns it here, before a browser
    // context, a scratch directory or a single screenshot has cost anything.
    await this.#deps.client.event(job, {
      seq: nextSeq(),
      kind: "chain_started",
      payload: {
        chainKey: chain.chainKey,
        attempt: job.attempt,
        stepCount: chain.stepCount,
        workerId: this.#deps.workerId,
        lane: this.#deps.lane,
      },
    });

    const policy = job.plan.policy;
    const ring = this.#deps.ring(job.jobRunId, policy.screenshots);
    const tracePath = join(this.#deps.traceDir, `${job.jobRunId}.zip`);
    await mkdir(this.#deps.traceDir, { recursive: true });
    this.#deps.oom.baseline();

    const guard = guardChainContext(this.#deps.engine, (handle) => {
      this.#deps.monitor.register(handle.contextId);
      this.#deps.onChainContext(handle);
    });
    const stopHeartbeat = this.#startLeaseHeartbeat(job, guard);

    let outcome: ChainOutcome;
    try {
      outcome = await this.#execute(job, chain, ring, guard, nextSeq, tracePath);
    } finally {
      stopHeartbeat();
      const opened = guard.handle();
      if (opened !== null) this.#deps.monitor.unregister(opened.contextId);
      this.#deps.onChainContext(null);
    }

    try {
      await this.#report(job, chain, outcome, ring, tracePath);
    } finally {
      // Scratch is finite and the next chain needs it. `discard()` is idempotent, and a trace
      // that was uploaded (or never written) removes just as cleanly as one that was not.
      await ring.discard();
      await rm(tracePath, { force: true });
    }
  }

  async #execute(
    job: ClaimedJob,
    chain: ChainPlan,
    ring: ScreenshotRing,
    guard: ChainContextGuard,
    nextSeq: () => number,
    tracePath: string,
  ): Promise<ChainOutcome> {
    const policy = job.plan.policy;
    return runChain(chain, policy, {
      engine: guard.engine,
      resolveVerb: this.#deps.resolveVerb,
      now: this.#deps.now,
      log: this.#deps.log,
      onStep: (step: StepOutcome) => {
        // Fire-and-forget so a slow control plane cannot pace the browser; a fence still lands,
        // because the rejection is routed into #onJobSignal, which closes the context at once.
        void this.#deps.client
          .event(job, { seq: nextSeq(), kind: "step_finished", payload: { ...step } })
          .catch((err: unknown) => {
            this.#onJobSignal(err, job, guard);
          });
      },
      screenshot: async (handle, step) => {
        if (policy.screenshots === "none") return null;
        const entry = await ring.push(step.execSeq, await handle.screenshotWebp());
        return entry?.sha256 ?? null;
      },
      // Retain-on-failure (§5.1): a green chain's trace is dropped while the context is still
      // alive, so it never reaches scratch, let alone the object store.
      finishTrace: async (handle, verdict) => {
        await handle.stopTracing(verdict === "failed" ? tracePath : null);
      },
    });
  }

  async #report(
    job: ClaimedJob,
    chain: ChainPlan,
    outcome: ChainOutcome,
    ring: ScreenshotRing,
    tracePath: string,
  ): Promise<void> {
    this.#assertWritable();

    const verdict = settledVerdict(outcome.verdict, this.#cancelled);
    if (verdict === null) {
      await this.#reportInfra(job, chain, outcome);
      return;
    }

    const evidence = await this.#uploadEvidence(job, ring, verdict, tracePath);
    this.#assertWritable();
    await this.#deps.client.complete(job, {
      verdict,
      steps: this.#completedSteps(outcome.steps, evidence.artifactIdBySha),
      artifacts: evidence.artifacts,
    });
    this.#deps.quarantine.onChainOk(chain.chainKey);
    this.#completed += 1;
  }

  async #reportInfra(job: ClaimedJob, chain: ChainPlan, outcome: ChainOutcome): Promise<void> {
    // Ask the kernel, not the stack trace: a killed renderer looks like "crash" from inside.
    const finding = this.#deps.oom.check(this.#deps.monitor.largest());
    if (finding.unreadable !== null) {
      // The kernel was not available to ask, so this report is the executor's own guess about an
      // infra failure that MAY have been an OOM. Say so: an operator seeing browser_oom vanish
      // from a host's incident mix needs to know the cgroup went unreadable, not assume health.
      this.#deps.log(
        `chain ${chain.chainKey} was NOT checked for a browser OOM: ${finding.unreadable}`,
      );
    }
    let infra: InfraPayload;
    if (finding.killed) {
      const decision = this.#deps.quarantine.onChainOom(chain.chainKey);
      if (decision.quarantined) this.#quarantined += 1;
      if (decision.alert !== null) {
        this.#deps.log(`ALERT ${decision.alert} for chain ${chain.chainKey} (oomCount=${decision.oomCount})`);
      }
      infra = {
        code: "browser_oom",
        // QUARANTINE IS THIS FLAG. The ledger only counts; what actually stops a poison chain
        // from burning a browser slot forever is handing the attempt back as NOT retryable.
        retryable: !decision.quarantined,
        message: boundedMessage(this.#deps.oom.toInfraError(finding).message),
        peakRssBytes: finding.peakRssBytes,
      };
    } else {
      infra = toContractInfra(outcome.infra);
    }

    await this.#deps.client.fail(job, infra);
    this.#infraFailures += 1;
  }

  /**
   * Retain-on-failure (§5.2): 95-97% of steps are green and cost zero PUTs. `screenshots: "all"`
   * is the interactive lane's opt-in — a QA is watching the gallery fill in live — and the trace
   * follows the stricter rule, kept only for a chain that actually failed.
   */
  async #uploadEvidence(
    job: ClaimedJob,
    ring: ScreenshotRing,
    verdict: CompletePayload["verdict"],
    tracePath: string,
  ): Promise<UploadedEvidence> {
    const policy = job.plan.policy;
    if (verdict !== "failed" && policy.screenshots !== "all") return NO_EVIDENCE;

    const artifacts: CompletedArtifact[] = [];
    const artifactIdBySha = new Map<string, string>();

    const trace = await readIfPresent(tracePath);
    if (trace !== null) {
      const sha256 = createHash("sha256").update(trace).digest("hex");
      const uploaded = await this.#putArtifact(job, "trace", TRACE_CONTENT_TYPE, trace, sha256, trace.length);
      if (uploaded !== null) artifacts.push({ kind: "trace", sha256, sizeBytes: trace.length });
    }

    for (const entry of await ring.keepForUpload()) {
      const bytes = await readIfPresent(entry.path);
      if (bytes === null) {
        this.#deps.log(`screenshot ${entry.sha256} vanished from scratch before upload; the gallery loses that frame`);
        continue;
      }
      const artifactId = await this.#putArtifact(
        job,
        "screenshot",
        SCREENSHOT_CONTENT_TYPE,
        bytes,
        entry.sha256,
        entry.sizeBytes,
      );
      if (artifactId === null) continue;
      artifactIdBySha.set(entry.sha256, artifactId);
      artifacts.push({ kind: "screenshot", sha256: entry.sha256, sizeBytes: entry.sizeBytes });
    }

    for (const skipped of ring.skipped()) {
      // "step 2" was ambiguous the moment one case could run ordinal 2 twice.
      this.#deps.log(
        `step #${String(skipped.execSeq)} produced no usable frame (${skipped.reason}, ${String(skipped.sizeBytes)} bytes)`,
      );
    }
    return { artifacts, artifactIdBySha };
  }

  /**
   * Returns the artifactId, or null when this piece of evidence was lost. LOSING EVIDENCE MUST NOT
   * LOSE THE VERDICT: a failed PUT is logged and the chain still reports its result. The three
   * fences are the exception — they are re-thrown, because they mean the job stopped being ours.
   */
  async #putArtifact(
    job: ClaimedJob,
    kind: ArtifactKind,
    contentType: string,
    body: Buffer,
    sha256: string,
    sizeBytes: number,
  ): Promise<string | null> {
    const rejection = presignRejection(sizeBytes);
    if (rejection !== null) {
      this.#deps.log(`${kind} artifact not offered for signing (${rejection}, ${sizeBytes} bytes)`);
      return null;
    }
    try {
      const target = await this.#deps.client.artifactTicket(job, { kind, contentType, sha256, sizeBytes });
      await this.#deps.uploader.upload({ kind, target, body, contentType });
      return target.artifactId;
    } catch (err) {
      if (err instanceof StaleEpochError || err instanceof JobCancelledError || err instanceof JobTerminalError) throw err;
      this.#deps.log(`${kind} artifact ${sha256} was lost: ${String(err)}`);
      return null;
    }
  }

  /**
   * There used to be a `(caseId, ordinal) -> renderedSentence` index built from the plan here.
   * It was WRONG, and silently: an inlined step group repeats the group's own ordinals inside
   * one case (packages/run-compiler/fixtures/group-inline-flat.golden.json: 1, 2, 3, 2), so the
   * LAST sentence written won the key and the report narrated the wrong step. The executor holds
   * the plan node at emission time and now carries the sentence on the outcome itself, which
   * needs no key at all.
   */
  #completedSteps(
    steps: readonly StepOutcome[],
    artifactIdBySha: ReadonlyMap<string, string>,
  ): readonly CompletedStep[] {
    return steps.map((step) => ({
      caseId: step.caseId,
      ordinal: step.ordinal,
      execSeq: step.execSeq,
      loopPath: [...step.loopPath],
      status: step.status,
      durationMs: Math.max(0, Math.round(step.durationMs)),
      renderedSentence: step.renderedSentence,
      failureContext: step.status === "failed" ? { message: step.message ?? "" } : null,
      screenshotArtifactId:
        step.screenshotSha256 === undefined ? null : (artifactIdBySha.get(step.screenshotSha256) ?? null),
      // TODO(M4): ThumbHash placeholders (§5.2) need an encoder this image does not ship. The
      // field travels explicitly as null so the hole is visible in the payload rather than implied
      // by the contract's default.
      thumbhash: null,
    }));
  }

  /**
   * Renews the lease for as long as the chain runs, and carries the plane's answer back:
   * `cancel` aborts the chain, `drain` retires the worker after it, a 409 fences it on the spot.
   */
  #startLeaseHeartbeat(job: ClaimedJob, guard: ChainContextGuard): () => void {
    const timer = setInterval(() => {
      void this.#deps.client
        .jobHeartbeat(job)
        .then((ack) => {
          if (job.jobRunId !== this.#currentJobRunId) return;
          if (ack.command === "cancel") {
            this.#cancelled = true;
            this.#deps.log(`job ${job.jobRunId} was cancelled by the control plane; aborting the chain`);
            guard.abort();
            return;
          }
          if (ack.command === "drain") this.requestDrain();
        })
        .catch((err: unknown) => {
          this.#onJobSignal(err, job, guard);
        });
    }, this.#deps.jobHeartbeatMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
    };
  }

  /**
   * Every asynchronous answer about a job funnels through here. A fence is recorded AND the
   * context is closed immediately — recording alone would let the chain drive a browser for
   * another fifteen minutes on behalf of a lease somebody else now holds.
   */
  #onJobSignal(err: unknown, job: ClaimedJob, guard: ChainContextGuard): void {
    if (job.jobRunId !== this.#currentJobRunId) return;
    if (
      err instanceof StaleEpochError ||
      err instanceof JobCancelledError ||
      err instanceof JobTerminalError ||
      err instanceof UnauthorizedError
    ) {
      this.#fence ??= err;
      guard.abort();
      return;
    }
    this.#deps.log(`job signal delivery failed (non-fatal): ${String(err)}`);
  }

  #assertWritable(): void {
    const fence = this.#fence;
    if (fence !== null) throw fence;
  }
}
