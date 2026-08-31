/**
 * HONESTY NOTE — what this suite proves and what it cannot.
 *
 * Every test here runs against a FAKE control plane (a stub object, not a socket), a FAKE
 * browser engine and a FAKE cgroup. What is proved is the worker's ORDERING, which is where all
 * the difficulty of the fleet lives: shed before claiming, fence before opening a context,
 * assertion ⇒ verdict / infra ⇒ fail(), a 409 STALE_EPOCH ⇒ write nothing more, ever.
 *
 * It is NOT evidence about a browser or a kernel:
 *  - `FakeBrowserEngine.close()` flips a boolean. So "the worker closed the chain's context the
 *    instant the epoch went stale" here means the worker CALLED close() — that closing a real
 *    context actually cancels the Playwright action still running behind it was measured on
 *    2026-08-29 and is re-proved by `test/browser/playwright-engine.test.ts` against chromium.
 *    On this fake the remaining steps keep running after the abort; a real engine throws.
 *  - `FakeMemoryLimiter.raiseOomKill()` is a counter, not a kernel OOM. That a nested cgroup
 *    really kills chromium and leaves node alive is `test/host/cgroup-v2.test.ts` (`test:host`).
 *  - That the far end agrees with these payloads is `apps/core`'s internal-plane suites plus the
 *    M3 acceptance soak; here the payloads are still built by the CONTRACT'S OWN schemas inside
 *    `control-plane-client.ts`, so a shape this worker cannot express fails at compile time.
 */
import { AssertionFailure, RetryableInfraError, UnauthorizedError } from "@testkite/contract";
import { PLAN_FORMAT_VERSION, type ChainPlan, type RunPlan, type ScreenshotPolicy, type StepPlan } from "@testkite/run-compiler";
import type { VerbDefinition } from "@testkite/verb-kit";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingUploader } from "../src/artifacts/uploader.js";
import { ScreenshotRing } from "../src/artifacts/screenshot-ring.js";
import type { BrowserEngine, EngineContextHandle } from "../src/browser/engine.js";
import { FakeBrowserEngine } from "../src/browser/fake-engine.js";
import {
  JobTerminalError,
  StaleEpochError,
  type ArtifactTicket,
  type ArtifactTicketRequest,
  type ClaimedJob,
  type CompleteAck,
  type CompletePayload,
  type ControlPlaneClient,
  type EventAck,
  type InfraPayload,
  type JobHeartbeatResponse,
  type RegisterResponse,
  type RunEventReport,
  type WorkerHeartbeatResponse,
} from "../src/control-plane-client.js";
import { ContextMemoryMonitor } from "../src/memory/context-monitor.js";
import { FakeMemoryLimiter } from "../src/memory/limiter.js";
import { OomReporter } from "../src/memory/oom-reporter.js";
import { FleetBreaker, QuarantineDecider, QuarantineLedger } from "../src/quarantine.js";
import { Worker, type WorkerDeps } from "../src/worker.js";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_RUN_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_JOB_RUN_ID = "77777777-7777-4777-8777-777777777777";
const CASE_ID = "55555555-5555-4555-8555-555555555555";
const ARTIFACT_ID = "66666666-6666-4666-8666-666666666666";

function actionStep(ordinal: number): StepPlan {
  return {
    kind: "action",
    ordinal,
    renderedSentence: `Click on button ${ordinal}`,
    groupPath: [],
    args: { element: "btn" },
    opKey: "web.click",
  };
}

function chainOf(chainKey: string, ordinals: readonly number[]): ChainPlan {
  return {
    chainKey,
    cases: [{ caseId: CASE_ID, revisionId: "rev-1", expectedToFail: false, steps: ordinals.map(actionStep) }],
    stepCount: ordinals.length,
    timeoutSeconds: 180,
  };
}

function planWith(chains: readonly ChainPlan[], screenshots: ScreenshotPolicy = "failure"): RunPlan {
  return {
    planFormatVersion: PLAN_FORMAT_VERSION,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    policy: { lane: "batch", engine: "chromium-headless-shell", retry: "infra-only", screenshots, baseUrl: "https://staging.test" },
    chains,
    contentHash: "0".repeat(64),
  };
}

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  jobRunId: JOB_RUN_ID,
  runId: RUN_ID,
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  chainKey: "login>checkout",
  attempt: 1,
  leaseEpoch: 7,
  leaseDeadlineAt: "2026-08-31T10:00:30.000Z",
  runToken: "tkr_run",
  plan: planWith([chainOf("login>checkout", [1, 2])]),
  ...over,
});

/**
 * A stub, not a mock framework: every assertion below is about what the worker SAID and in what
 * order, so the stub is a recorder with three scripted refusals (stale epoch, a terminal job,
 * a heartbeat command).
 */
class StubClient implements ControlPlaneClient {
  readonly queue: (ClaimedJob | null)[] = [];
  readonly completed: CompletePayload[] = [];
  readonly failures: InfraPayload[] = [];
  readonly events: RunEventReport[] = [];
  readonly tickets: ArtifactTicketRequest[] = [];
  readonly freeSlotsSeen: number[] = [];
  claims = 0;
  jobHeartbeats = 0;
  staleOn: "complete" | "event" | "heartbeat" | null = null;
  /** With `staleOn: "event"`, the first seq that is refused — lets a test fence mid-chain only. */
  staleFromSeq = 1;
  /** The first seq answered with a 401, or null. Models a credential that expired mid-chain. */
  unauthorizedFromSeq: number | null = null;
  heartbeatCommand: JobHeartbeatResponse["command"] = "continue";
  completeThrows: Error | null = null;

  async register(): Promise<RegisterResponse> {
    return { workerId: "w-1", lane: "batch", workerToken: "tkw_1", heartbeatIntervalMs: 5_000, drain: false };
  }

  async workerHeartbeat(): Promise<WorkerHeartbeatResponse> {
    return { command: "continue", workerTokenRenewedAt: null };
  }

  async claim(req: { readonly freeSlots: number }): Promise<ClaimedJob | null> {
    this.claims += 1;
    this.freeSlotsSeen.push(req.freeSlots);
    return this.queue.shift() ?? null;
  }

  async jobHeartbeat(j: ClaimedJob): Promise<JobHeartbeatResponse> {
    this.jobHeartbeats += 1;
    if (this.staleOn === "heartbeat") throw this.#stale(j);
    return { leaseDeadlineAt: "2026-08-31T10:01:00.000Z", command: this.heartbeatCommand };
  }

  async event(j: ClaimedJob, e: RunEventReport): Promise<EventAck> {
    if (this.unauthorizedFromSeq !== null && e.seq >= this.unauthorizedFromSeq) {
      throw new UnauthorizedError("control plane rejected this worker's credential on /internal/events");
    }
    if (this.staleOn === "event" && e.seq >= this.staleFromSeq) throw this.#stale(j);
    this.events.push(e);
    return { accepted: true, duplicate: false };
  }

  async artifactTicket(_j: ClaimedJob, req: ArtifactTicketRequest): Promise<ArtifactTicket> {
    this.tickets.push(req);
    return {
      artifactId: ARTIFACT_ID,
      url: `https://blob.test/${req.sha256}`,
      method: "PUT",
      headers: { "content-type": req.contentType },
      expiresAt: "2026-08-31T10:05:00.000Z",
    };
  }

  async complete(j: ClaimedJob, p: CompletePayload): Promise<CompleteAck> {
    if (this.staleOn === "complete") throw this.#stale(j);
    if (this.completeThrows !== null) throw this.completeThrows;
    this.completed.push(p);
    return { ok: true, requeued: false, attempt: j.attempt };
  }

  async fail(j: ClaimedJob, infra: InfraPayload): Promise<CompleteAck> {
    if (this.staleOn === "complete") throw this.#stale(j);
    this.failures.push(infra);
    return { ok: true, requeued: infra.retryable, attempt: j.attempt };
  }

  #stale(j: ClaimedJob): StaleEpochError {
    return new StaleEpochError(j.jobRunId, j.leaseEpoch, j.leaseEpoch + 1, "lease reaped");
  }
}

/**
 * Wraps the fake engine so `stopTracing(path)` actually leaves a file there. Without it the CI
 * suite could only prove the RETENTION DECISION (keep vs drop); with it the trace's ticket +
 * PUT are exercised too. It is still a zip-shaped lie — that a real trace replays is
 * `test/browser/playwright-engine.test.ts`.
 */
function traceWritingEngine(inner: FakeBrowserEngine, bytes: Buffer): BrowserEngine {
  return {
    kind: inner.kind,
    async newChainContext(options) {
      const handle = await inner.newChainContext(options);
      const wrapped: EngineContextHandle = {
        contextId: handle.contextId,
        get closed(): boolean {
          return handle.closed;
        },
        opContext: (stepTimeoutMs, log) => handle.opContext(stepTimeoutMs, log),
        rendererPids: () => handle.rendererPids(),
        screenshotWebp: () => handle.screenshotWebp(),
        stopTracing: async (destPath) => {
          if (destPath !== null) await writeFile(destPath, bytes);
          await handle.stopTracing(destPath);
        },
        close: () => handle.close(),
      };
      return wrapped;
    },
    browserPid: () => inner.browserPid(),
    contextsServed: () => inner.contextsServed(),
    treeRssBytes: () => inner.treeRssBytes(),
    crashed: () => inner.crashed(),
    close: () => inner.close(),
  };
}

let client: StubClient;
let engine: FakeBrowserEngine;
let uploader: RecordingUploader;
let limiter: FakeMemoryLimiter;
let scratch: string;

function deps(execute: VerbDefinition["execute"], over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    client,
    engine,
    ring: (scratchKey, policy) => new ScreenshotRing({ dir: join(scratch, scratchKey), capacity: 50, policy }),
    uploader,
    quarantine: new QuarantineDecider(
      new QuarantineLedger(),
      new FleetBreaker({ windowMs: 600_000, minSamples: 100, oomRatePct: 50, now: () => Date.now() }),
    ),
    oom: new OomReporter(limiter),
    monitor: new ContextMemoryMonitor({ sampleRss: () => null, onAction: () => {} }),
    onChainContext: () => {},
    resolveVerb: (): VerbDefinition => ({ opKey: "web.click", sentence: "Click on {element}", params: [], needsRendering: true, execute }),
    now: () => Date.now(),
    log: () => {},
    workerId: "w-1",
    lane: "batch",
    maxContexts: 4,
    containerLimitBytes: 3072 * 1024 * 1024,
    traceDir: join(scratch, "traces"),
    // Far longer than any test chain: the heartbeat only fires in the tests that ask for it.
    jobHeartbeatMs: 600_000,
    ...over,
  };
}

beforeEach(() => {
  client = new StubClient();
  engine = new FakeBrowserEngine();
  uploader = new RecordingUploader();
  limiter = new FakeMemoryLimiter();
  limiter.setLimit(2672 * 1024 * 1024);
  scratch = mkdtempSync(join(tmpdir(), "tk-worker-"));
});

const passing: VerbDefinition["execute"] = async () => ({ ok: true });

describe("Worker", () => {
  it("returns idle when the queue is empty and never opens a browser context", async () => {
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("idle");
    expect(engine.contextsServed()).toBe(0);
  });

  it("claims one slot at a time — fleet width is four ts-worker@ instances, not four chains here", async () => {
    const w = new Worker(deps(passing));
    await w.runOnce();
    expect(client.freeSlotsSeen).toEqual([1]);
  });

  it("claims, runs and completes a passing chain", async () => {
    client.queue.push(job());
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("ran");
    expect(client.completed).toHaveLength(1);
    expect(client.completed[0]?.verdict).toBe("passed");
    expect(w.stats()).toMatchObject({ claimed: 1, completed: 1 });
  });

  it("runs the chain the JOB names, not simply the plan's first chain", async () => {
    const plan = planWith([chainOf("smoke>login", [1]), chainOf("login>checkout", [1, 2])]);
    client.queue.push(job({ chainKey: "login>checkout", plan }));
    const w = new Worker(deps(passing));
    await w.runOnce();
    expect(client.completed[0]?.steps.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it("fails the job — instead of crashing the loop — when the plan carries no such chain", async () => {
    client.queue.push(job({ chainKey: "ghost>chain" }));
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("ran");
    expect(client.completed).toHaveLength(0);
    expect(client.failures[0]).toMatchObject({ retryable: false });
    expect(engine.contextsServed()).toBe(0);
  });

  it("announces chain_started BEFORE opening a context, so a fenced worker burns no browser", async () => {
    client.queue.push(job());
    client.staleOn = "event";
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("stopped");
    expect(engine.contextsServed()).toBe(0);
    expect(w.stats().zombieSuicides).toBe(1);
  });

  it("completes with verdict=failed on an AssertionFailure and does NOT report an infra error", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => {
      throw new AssertionFailure("text mismatch");
    }));
    await w.runOnce();
    expect(client.completed[0]?.verdict).toBe("failed");
    expect(client.failures).toHaveLength(0);
  });

  it("reports an infra error through fail() and never as a verdict", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => {
      throw new RetryableInfraError("context_crash", "gone");
    }));
    await w.runOnce();
    expect(client.completed).toHaveLength(0);
    expect(client.failures[0]).toMatchObject({ code: "context_crash", retryable: true });
    expect(w.stats().infraFailures).toBe(1);
  });

  it("maps an infra code the contract does not know onto one it does, rather than dying at encode time", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => {
      throw new Error("something nobody classified");
    }));
    expect(await w.runOnce()).toBe("ran");
    expect(client.failures[0]).toMatchObject({ code: "context_crash", retryable: false });
    expect(client.failures[0]?.message).toContain("fatal_infra");
  });

  it("attaches peakRss when the cgroup says chromium was OOM-killed", async () => {
    client.queue.push(job());
    limiter.setPeak(1_728_053_248);
    const w = new Worker(deps(async () => {
      limiter.raiseOomKill();
      throw new RetryableInfraError("context_crash", "renderer gone");
    }));
    await w.runOnce();
    expect(client.failures[0]).toMatchObject({ code: "browser_oom", peakRssBytes: 1_728_053_248 });
  });

  /**
   * `FakeMemoryLimiter.setUnreadable` scripts what a broken cgroup mount produces. The point is
   * that the finding does NOT silently become "no OOM": an infra failure whose OOM check never
   * ran must say so, or an operator reads a host whose browser_oom rate quietly went to zero as
   * a host that stopped OOM-ing.
   */
  it("says out loud when an infra failure could not be checked against the cgroup", async () => {
    client.queue.push(job());
    limiter.setUnreadable("memory.events could not be read (EISDIR)");
    const lines: string[] = [];
    const w = new Worker(deps(async () => {
      throw new RetryableInfraError("context_crash", "renderer gone");
    }, { log: (m: string) => lines.push(m) }));
    await w.runOnce();
    expect(lines.some((l) => l.includes("NOT checked for a browser OOM") && l.includes("EISDIR"))).toBe(true);
    // The executor's own classification still goes out — an unreadable cgroup loses the OOM
    // upgrade, it never loses the report.
    expect(client.failures[0]).toMatchObject({ code: "context_crash" });
  });

  it("STALE_EPOCH on complete: stops immediately, writes nothing more, counts a zombie suicide", async () => {
    client.queue.push(job());
    client.staleOn = "complete";
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("stopped");
    expect(client.completed).toHaveLength(0);
    expect(client.failures).toHaveLength(0); // NOT even an infra report
    expect(uploader.uploads).toHaveLength(0); // NOT even an artifact
    expect(w.stats().zombieSuicides).toBe(1);
  });

  it("STALE_EPOCH mid-chain aborts the chain and still closes the context", async () => {
    client.queue.push(job());
    client.staleOn = "event";
    client.staleFromSeq = 2; // chain_started (seq 1) is accepted; the first step_finished is not
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("stopped");
    expect(engine.openContextIds.size).toBe(0);
    expect(client.completed).toHaveLength(0);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("closes the running chain's context the moment the epoch goes stale, not after the last step", async () => {
    client.queue.push(job({ plan: planWith([chainOf("login>checkout", [1, 2, 3])]) }));
    client.staleOn = "event";
    client.staleFromSeq = 2;
    const openWhenStepRan: number[] = [];
    const w = new Worker(deps(async () => {
      openWhenStepRan.push(engine.openContextIds.size);
      return { ok: true };
    }));
    await w.runOnce();
    // Step 1 ran inside a live context; by step 2 the worker had already closed it. On a REAL
    // engine step 2 would throw instead of running at all — closing is the only cancellation
    // Playwright has (measured 2026-08-29), and this fake cannot show that half.
    expect(openWhenStepRan[0]).toBe(1);
    expect(openWhenStepRan[1]).toBe(0);
  });

  /**
   * A 401 is the same class of answer as a 409: the plane is refusing to hear from this worker.
   * Before this test the rejection was logged as "non-fatal" and the chain kept driving a REAL
   * browser on the tenant's system for the rest of the chain budget (up to 900s) while the lease
   * was already reaped and another attempt was running the same chain — duplicate side effects
   * against the tenant's app, paid for by a credential that no longer exists.
   */
  it("401 mid-chain fences the worker exactly like a stale epoch: the context closes at once", async () => {
    client.queue.push(job({ plan: planWith([chainOf("login>checkout", [1, 2, 3])]) }));
    client.unauthorizedFromSeq = 2; // chain_started (seq 1) lands; the first step_finished is refused
    const openWhenStepRan: number[] = [];
    const w = new Worker(deps(async () => {
      openWhenStepRan.push(engine.openContextIds.size);
      return { ok: true };
    }));
    // Not "ran": the fence escapes runOnce, and `main()` turns it into a process exit whose
    // systemd restart re-registers the worker with a fresh credential.
    await expect(w.runOnce()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(openWhenStepRan[0]).toBe(1);
    expect(openWhenStepRan[1]).toBe(0); // guard.abort() closed the context before step 2 started
    expect(engine.openContextIds.size).toBe(0);
  });

  it("401 mid-chain writes nothing more: no verdict, no infra report, no artifact", async () => {
    client.queue.push(job());
    client.unauthorizedFromSeq = 2;
    const w = new Worker(deps(async () => ({ ok: false, failureMessage: "no button" })));
    await expect(w.runOnce()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(client.completed).toHaveLength(0);
    expect(client.failures).toHaveLength(0);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("never claims again after a suicide — a fenced worker is done, not merely done with this job", async () => {
    client.queue.push(job());
    client.staleOn = "complete";
    const w = new Worker(deps(passing));
    await w.runOnce();
    expect(await w.runOnce()).toBe("stopped");
    expect(client.claims).toBe(1);
  });

  it("swallows a 410 JOB_TERMINAL on complete: a redelivered answer is normal, not a crash", async () => {
    client.queue.push(job());
    client.completeThrows = new JobTerminalError(JOB_RUN_ID, "already finished");
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("ran");
    expect(w.stats().zombieSuicides).toBe(0);
  });

  it("uploads the screenshot gallery only when the chain fails", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => ({ ok: false, failureMessage: "no button" })));
    await w.runOnce();
    expect(uploader.uploads.length).toBeGreaterThan(0);
    expect(uploader.uploads.every((u) => u.kind === "screenshot")).toBe(true);

    client.queue.push(job());
    const before = uploader.uploads.length;
    const w2 = new Worker(deps(passing));
    await w2.runOnce();
    expect(uploader.uploads.length).toBe(before); // a green batch chain costs zero PUTs
  });

  it("uploads every step of a green chain when the policy is `all` — a QA is watching live", async () => {
    client.queue.push(job({ plan: planWith([chainOf("login>checkout", [1, 2])], "all") }));
    const w = new Worker(deps(passing));
    await w.runOnce();
    expect(uploader.uploads.length).toBeGreaterThan(0);
  });

  it("captures nothing at all when the policy is `none`", async () => {
    client.queue.push(job({ plan: planWith([chainOf("login>checkout", [1, 2])], "none") }));
    const w = new Worker(deps(async () => ({ ok: false, failureMessage: "no button" })));
    await w.runOnce();
    expect(uploader.uploads).toHaveLength(0);
    expect(client.completed[0]?.steps[0]?.screenshotArtifactId ?? null).toBeNull();
  });

  it("keeps the trace when the chain fails and uploads it as kind=trace", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => ({ ok: false, failureMessage: "no button" }), {
      engine: traceWritingEngine(engine, Buffer.from("PK pretend-trace")),
    }));
    await w.runOnce();
    expect(uploader.uploads.map((u) => u.kind)).toContain("trace");
    expect(client.completed[0]?.artifacts.map((a) => a.kind)).toContain("trace");
  });

  it("discards the trace when the chain passes — retain-on-failure costs a green run nothing", async () => {
    client.queue.push(job());
    const w = new Worker(deps(passing, { engine: traceWritingEngine(engine, Buffer.from("PK pretend-trace")) }));
    await w.runOnce();
    expect(engine.tracesDiscarded).toBe(1);
    expect(engine.tracesKept).toHaveLength(0);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("carries the four presentation fields to complete, so the per-step gallery is not a silent hole", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => ({ ok: false, failureMessage: "no button" })));
    await w.runOnce();
    const step = client.completed[0]?.steps[0];
    expect(step).toMatchObject({
      caseId: CASE_ID,
      ordinal: 1,
      status: "failed",
      renderedSentence: "Click on button 1",
      screenshotArtifactId: ARTIFACT_ID,
    });
    expect(step?.failureContext).toMatchObject({ message: "no button" });
  });

  it("quarantines a chain after two OOMs and hands it back as NOT retryable", async () => {
    const w = new Worker(deps(async () => {
      limiter.raiseOomKill();
      throw new RetryableInfraError("context_crash", "gone");
    }));
    client.queue.push(job());
    await w.runOnce();
    expect(client.failures[0]).toMatchObject({ code: "browser_oom", retryable: true });
    client.queue.push(job());
    await w.runOnce();
    expect(w.stats().quarantined).toBe(1);
    expect(client.failures.at(-1)).toMatchObject({ code: "browser_oom", retryable: false });
  });

  it("sheds instead of claiming when container memory is above 75%", async () => {
    client.queue.push(job());
    const claim = vi.spyOn(client, "claim");
    engine.setRendererRss("ballast", 2_400 * 1024 * 1024);
    const w = new Worker(deps(passing));
    expect(await w.runOnce()).toBe("shed");
    expect(claim).not.toHaveBeenCalled();
  });

  it("stops claiming after requestDrain() but finishes what it holds", async () => {
    client.queue.push(job());
    const w = new Worker(deps(passing));
    w.requestDrain();
    expect(await w.runOnce()).toBe("stopped");
    expect(client.claims).toBe(0);
    expect(client.completed).toHaveLength(0);
  });

  it("renews the lease while the chain runs — an unrenewed lease is reaped and makes its own zombie", async () => {
    client.queue.push(job());
    const w = new Worker(deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: true };
    }, { jobHeartbeatMs: 5 }));
    await w.runOnce();
    expect(client.jobHeartbeats).toBeGreaterThan(0);
    expect(client.completed[0]?.verdict).toBe("passed");
  });

  it("stops renewing once the chain is over", async () => {
    client.queue.push(job());
    const w = new Worker(deps(passing, { jobHeartbeatMs: 5 }));
    await w.runOnce();
    const after = client.jobHeartbeats;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.jobHeartbeats).toBe(after);
  });

  it("aborts the chain and completes it as cancelled when the lease heartbeat says cancel", async () => {
    client.queue.push(job());
    client.heartbeatCommand = "cancel";
    const w = new Worker(deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: true };
    }, { jobHeartbeatMs: 5 }));
    await w.runOnce();
    expect(client.completed[0]?.verdict).toBe("cancelled");
    expect(engine.openContextIds.size).toBe(0);
  });

  it("drains at the end of the chain when the lease heartbeat says drain", async () => {
    client.queue.push(job());
    client.heartbeatCommand = "drain";
    const w = new Worker(deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    }, { jobHeartbeatMs: 5 }));
    expect(await w.runOnce()).toBe("ran");
    expect(client.completed[0]?.verdict).toBe("passed");
    expect(await w.runOnce()).toBe("stopped");
  });

  it("a STALE_EPOCH from the lease heartbeat is a suicide too", async () => {
    client.queue.push(job());
    client.staleOn = "heartbeat";
    const w = new Worker(deps(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: true };
    }, { jobHeartbeatMs: 5 }));
    expect(await w.runOnce()).toBe("stopped");
    expect(client.completed).toHaveLength(0);
    expect(w.stats().zombieSuicides).toBe(1);
  });

  it("ignores a fence that arrives about a job that already ended, even mid-way through the next one", async () => {
    const forward = client.event.bind(client);
    vi.spyOn(client, "event").mockImplementation(async (j, e) => {
      // Only the FIRST job's step events go bad, and they go bad late: the shape of a POST still
      // in flight when its chain finished. Acting on it would fence a worker over a dead lease.
      if (j.jobRunId !== JOB_RUN_ID || e.kind !== "step_finished") return forward(j, e);
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new StaleEpochError(j.jobRunId, j.leaseEpoch, j.leaseEpoch + 1, "reaped after the fact");
    });

    let calls = 0;
    const w = new Worker(deps(async () => {
      calls += 1;
      // The second job is slow enough to still be running when the first job's answer lands.
      if (calls > 2) await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true };
    }));

    client.queue.push(job());
    expect(await w.runOnce()).toBe("ran");
    client.queue.push(job({ jobRunId: SECOND_JOB_RUN_ID }));
    expect(await w.runOnce()).toBe("ran");
    expect(w.stats()).toMatchObject({ completed: 2, zombieSuicides: 0 });
  });

  it("publishes the live context so L3 can sample it, and withdraws it when the chain ends", async () => {
    client.queue.push(job());
    const seen: (string | null)[] = [];
    const w = new Worker(deps(passing, { onChainContext: (handle) => seen.push(handle?.contextId ?? null) }));
    await w.runOnce();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("login>checkout");
    expect(seen[1]).toBeNull();
  });
});
