/**
 * @testkite/runner — worker container: control-plane client x Playwright chromium-headless-shell.
 *
 * INVARIANTS (docs/SYSTEM_DESIGN.md §5):
 *  - The worker holds NO database or object-store credential: the plan arrives with the claim and
 *    artifacts go out through a presigned PUT the control plane signed. The only secret in this
 *    process is the host bootstrap token, and it is spent once, on `register`.
 *  - AssertionFailure ⇒ the job COMPLETES with verdict=failed. Only a RetryableInfraError retries.
 *  - Every /internal/fleet mutation carries leaseEpoch — a stale epoch gets 409 STALE_EPOCH and the
 *    zombie stops writing anything at all, then stops claiming.
 *  - One context = one chain, closed in `finally`. The login session lives inside that context.
 *
 * THIS FILE IS WIRING, AND WIRING IS NOT TESTED HERE. Every part it assembles has its own suite;
 * what only a real host can show is the assembly: a cgroup that exists, an `oom_score_adj` that is
 * allowed to go negative, and a chromium that starts WITH its OS sandbox — which this dev sandbox
 * cannot do at all, because it runs as root and chromium's zygote refuses to sandbox for root
 * (see `resolveChromiumSandbox`). Nothing below opts out of the sandbox: the fleet runs
 * unprivileged, and a container that cannot start a sandboxed browser must fail loudly here.
 */
import { getVerb } from "@testkite/verb-kit";
import { mkdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { HttpArtifactUploader } from "./artifacts/uploader.js";
import { ScreenshotRing } from "./artifacts/screenshot-ring.js";
import type { EngineContextHandle } from "./browser/engine.js";
import { launchPlaywrightEngine } from "./browser/playwright-engine.js";
import { loadRunnerConfig } from "./config.js";
import { HttpControlPlaneClient } from "./control-plane-client.js";
import { ContextMemoryMonitor } from "./memory/context-monitor.js";
import {
  browserCgroupLimitBytes,
  CgroupV2MemoryLimiter,
  detectCgroupV2Memory,
  FakeMemoryLimiter,
  type MemoryLimiter,
} from "./memory/limiter.js";
import { OomReporter } from "./memory/oom-reporter.js";
import { OOM_SCORE_CHROMIUM, OOM_SCORE_NODE, setOomScoreAdj } from "./memory/oom-score.js";
import { MEMORY } from "./memory-governance.js";
import { sumRssBytes } from "./memory/rss.js";
import { FleetBreaker, QuarantineDecider, QuarantineLedger } from "./quarantine.js";
import { Worker } from "./worker.js";

/**
 * Distinct blobs a chain may leave on scratch. At the spike's ~2.4KB per WebP frame this is a
 * fraction of a megabyte even before dedup, and the ring evicts the oldest beyond it.
 */
const SCREENSHOT_RING_CAPACITY = 200;

/** The nested browser cgroup (L2). A directory on cgroupfs IS the cgroup — mkdir creates it. */
const BROWSER_CGROUP_DIR = "/sys/fs/cgroup/ts-browser";

/** Fleet-wide OOM breaker: 10 minutes of history, and no opinion before 20 chains have run. */
const BREAKER = { windowMs: 600_000, minSamples: 20, oomRatePct: 50 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * L2: the browser goes into a nested cgroup and becomes the kernel's preferred OOM victim, so a
 * runaway page kills chromium and leaves node alive to say so. Every failure here DEGRADES LOUDLY
 * rather than pretending: without the nested ceiling the worker still runs, but a kernel kill will
 * look like an unexplained crash instead of `browser_oom`, and an operator has to be told that.
 */
function attachBrowserCgroup(
  containerLimitBytes: number,
  browserPid: number | null,
  log: (message: string) => void,
): MemoryLimiter {
  if (!detectCgroupV2Memory()) {
    log("no cgroup v2 memory controller on this host — L2 nested limiting is INACTIVE and a kernel kill will not be self-diagnosed");
    return new FakeMemoryLimiter();
  }
  try {
    mkdirSync(BROWSER_CGROUP_DIR, { recursive: true });
    const cgroup = new CgroupV2MemoryLimiter(BROWSER_CGROUP_DIR);
    cgroup.setLimit(browserCgroupLimitBytes(containerLimitBytes));
    if (browserPid === null) {
      log("the engine did not report a browser pid — the nested cgroup exists but holds nothing");
      return cgroup;
    }
    cgroup.attach(browserPid);
    if (setOomScoreAdj(browserPid, OOM_SCORE_CHROMIUM) === "denied") {
      log("could not raise chromium oom_score_adj — the kernel may pick node as the OOM victim instead");
    }
    if (setOomScoreAdj(process.pid, OOM_SCORE_NODE) === "denied") {
      log("could not lower node oom_score_adj — CAP_SYS_RESOURCE is missing, node is NOT protected");
    }
    return cgroup;
  } catch (err) {
    log(`nested browser cgroup could not be set up (${String(err)}) — L2 is INACTIVE on this worker`);
    return new FakeMemoryLimiter();
  }
}

async function main(): Promise<void> {
  // Fail fast and loudly on a bad environment: a worker that boots with a half-valid config is
  // worse than one that never boots — systemd restarts it, and the unit log names the field.
  const config = loadRunnerConfig(process.env);
  const log = (message: string): void => {
    console.log(JSON.stringify({ at: new Date().toISOString(), worker: config.workerName, message }));
  };

  const client = new HttpControlPlaneClient({ baseUrl: config.controlPlaneUrl, bootstrapToken: config.bootstrapToken });
  const registration = await client.register({
    workerId: config.workerName,
    hostname: hostname(),
    lane: config.lane,
    // ONE. `Worker.runOnce` executes a single chain at a time, so the roster row says one slot.
    // `MEMORY.contextsPerWorker` is the container's context ceiling and becomes the worker's
    // capacity only when the loop runs chains concurrently; claiming K today would have the
    // dispatcher hold work for slots that do not exist.
    capacity: 1,
  });

  // Scratch is wiped at boot, not at exit: a container that was OOM-killed or SIGKILLed never got
  // to clean up, and its blobs would otherwise outlive every run they belonged to.
  const scratchDir = join(config.workspaceDir, "scratch");
  const traceDir = join(config.workspaceDir, "traces");
  for (const dir of [scratchDir, traceDir]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const engine = await launchPlaywrightEngine({ traceDir });
  const limiter = attachBrowserCgroup(config.containerLimitBytes, engine.browserPid(), log);

  // L3: the chain's own context is the only thing worth sampling, because this worker runs one
  // chain at a time — and a context over the hard ceiling is CLOSED, which is the only way to
  // stop the page inside it (a lost race does not cancel Playwright; the 2026-08-29 spike measured
  // that). Closing surfaces to the executor as an infra error and the chain is handed back.
  let liveContext: EngineContextHandle | null = null;
  const monitor = new ContextMemoryMonitor({
    sampleRss: (contextId) => {
      const handle = liveContext;
      if (handle === null || handle.contextId !== contextId) return null;
      return sumRssBytes(handle.rendererPids());
    },
    onAction: (sample) => {
      log(`context ${sample.contextId} ${sample.action} at ${sample.rssBytes} bytes`);
      const handle = liveContext;
      if (sample.action !== "hard-abort" || handle === null || handle.contextId !== sample.contextId) return;
      log(`context ${sample.contextId} crossed the ${MEMORY.contextHardMb}MB hard ceiling — closing it`);
      void handle.close().catch((err: unknown) => {
        log(`hard-abort close failed: ${String(err)}`);
      });
    },
  });
  monitor.start();

  const worker = new Worker({
    client,
    engine,
    ring: (scratchKey, policy) =>
      new ScreenshotRing({ dir: join(scratchDir, scratchKey), capacity: SCREENSHOT_RING_CAPACITY, policy }),
    uploader: new HttpArtifactUploader({}),
    quarantine: new QuarantineDecider(new QuarantineLedger(), new FleetBreaker({ ...BREAKER, now: () => Date.now() })),
    oom: new OomReporter(limiter),
    monitor,
    onChainContext: (handle) => {
      liveContext = handle;
    },
    resolveVerb: getVerb,
    now: () => Date.now(),
    log,
    workerId: registration.workerId,
    lane: registration.lane,
    maxContexts: config.maxContexts,
    containerLimitBytes: config.containerLimitBytes,
    traceDir,
    jobHeartbeatMs: config.heartbeatIntervalMs,
  });

  const shutdown = (): void => {
    worker.requestDrain();
    log("drain requested, finishing the current chain");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The roster can retire a worker at registration time — honour it instead of claiming once first.
  if (registration.drain) {
    log("the control plane registered this worker in drain state; not claiming");
    worker.requestDrain();
  }

  log(
    `runner up: lane=${registration.lane} contextCeiling=${config.maxContexts} ` +
      `containerLimits=${JSON.stringify(MEMORY.containerLimitMb)} limiter=${limiter.kind}`,
  );
  for (;;) {
    const result = await worker.runOnce();
    if (result === "stopped") break;
    if (result === "idle" || result === "shed") await sleep(config.claimIdleMs);
  }

  monitor.stop();
  await engine.close();
  log(`runner down: ${JSON.stringify(worker.stats())}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
