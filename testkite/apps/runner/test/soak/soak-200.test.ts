/**
 * THE ACCEPTANCE SOAK — the evidence that the old system's failure class (docs/SYSTEM_DESIGN.md
 * §1: browsers that leak until the host dies) cannot be rebuilt here.
 *
 * WHAT RUNS. A real chromium-headless-shell, the real `Worker` loop, and a `FakeControlPlane`
 * that speaks the SETTLED contract over a real socket. Every chain therefore travels the whole
 * production path: claim -> `chain_started` fence -> one context -> steps -> per-step WebP through
 * CDP into the ring on scratch -> trace started and (green chain) dropped -> `complete`. The
 * browser is recycled from `browserRecycleReason` exactly as the fleet recycles it, so a 200-chain
 * soak also exercises four real browser teardowns, not one.
 *
 * WHAT IT PROVES. Four numbers, each a ceiling this milestone exists to defend:
 *   1. node's RSS floor does not creep (< `MEMORY.recycle.containerRssFloorGrowthPct`);
 *   2. the chromium tree never approaches the L1 container ceiling;
 *   3. no context outlives its chain;
 *   4. no chromium process outlives its browser.
 *
 * WHAT IT DOES NOT PROVE — read this before quoting a green run.
 *   - THE SANDBOX. Chromium's zygote refuses to sandbox as root and this dev/CI box is root, so
 *     the engine is launched with the explicit `off-root-dev-only` opt-out and everything below
 *     is measured UNSANDBOXED. The production shape (uid 10001, sandbox on) is proven only by
 *     `test/host/chromium-sandbox.test.ts` under `test:host`.
 *   - THE CONTROL PLANE. `FakeControlPlane` is in-process: it validates every request with the
 *     contract's own schemas and answers with them, which proves THE WORKER SPEAKS THE CONTRACT.
 *     Lease reaping, `FOR UPDATE SKIP LOCKED` claiming, run-token TTL and real presigned PUTs are
 *     `apps/core`'s suites, and the end-to-end pilot is host evidence (tasks/open-questions.md §5).
 *   - THE KERNEL. No cgroup ceiling is applied here (this sandbox is cgroup v1 hybrid without
 *     CAP_SYS_RESOURCE); that a nested cgroup kills chromium and spares node is
 *     `test/host/cgroup-v2.test.ts` under `test:host`.
 *   - SECONDS PER CHAIN. `msPerChainP50` is reported for TREND only. This box is a 4-vCPU shared
 *     sandbox; a capacity number for the fleet has to come from the pilot host.
 *
 * SCALE. The full 200 chains run in the nightly CI job: measured 2026-08-31, 177s end to end at
 * ~870ms per chain, so nothing had to be cut down for CI. `TESTKITE_SOAK_CHAINS` overrides the
 * default only so a developer can take a 20-chain reading in seconds. The THRESHOLDS NEVER MOVE
 * WITH THE SCALE — a smaller run is a weaker sample of the same ceilings, never a laxer one.
 *
 * The whole file is out of the default vitest run (`vitest.config.ts` excludes `test/soak/**`
 * unless TESTKITE_SOAK=1), so `pnpm test` neither runs it nor reports it as a skip.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbDefinition } from "@testkite/verb-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RecordingUploader } from "../../src/artifacts/uploader.js";
import { ScreenshotRing } from "../../src/artifacts/screenshot-ring.js";
import type { BrowserEngine, EngineContextHandle } from "../../src/browser/engine.js";
import { launchPlaywrightEngine, type PlaywrightBrowserEngine } from "../../src/browser/playwright-engine.js";
import { HttpControlPlaneClient } from "../../src/control-plane-client.js";
import { ContextMemoryMonitor } from "../../src/memory/context-monitor.js";
import { FakeMemoryLimiter } from "../../src/memory/limiter.js";
import { OomReporter } from "../../src/memory/oom-reporter.js";
import { browserRecycleReason } from "../../src/memory/recycler.js";
import { readRssBytes } from "../../src/memory/rss.js";
import { MEMORY } from "../../src/memory-governance.js";
import { FleetBreaker, QuarantineDecider, QuarantineLedger } from "../../src/quarantine.js";
import { Worker } from "../../src/worker.js";
import { FAKE_BOOTSTRAP_TOKEN, FakeControlPlane } from "../harness/fake-control-plane.js";
import {
  buildSyntheticPlan,
  DEFAULT_SOAK_CHAINS,
  SOAK_OP_KEY,
  SOAK_STEPS_PER_CHAIN,
  SYNTHETIC_URL,
  type SoakReport,
} from "./synthetic-app.js";

const MB = 1024 * 1024;

const CHAINS = Number(process.env["TESTKITE_SOAK_CHAINS"] ?? DEFAULT_SOAK_CHAINS);

/**
 * The kernel reaps a closed browser's children asynchronously. The 2026-08-29 spike counted 2
 * "orphans" the instant `close()` resolved and 0 after 1.5s — so asserting without this window
 * measures the reaper's latency and calls it a leak. A FALSE RED costs more than no test.
 */
const ORPHAN_SETTLE_MS = 1_500;

/** Generous by design: the point of a soak is to run long, not to race a wall clock. */
const SOAK_TIMEOUT_MS = Math.max(120_000, CHAINS * 10_000);

/**
 * Chains run before the RSS FLOOR is read as the baseline. ONE, and the reason is not tuning.
 *
 * `containerRecycleReason` compares an RSS floor "measured BETWEEN jobs, when nothing should
 * still be held" against a baseline floor. A reading taken before the worker has ever run a job
 * is not that: it predates the one-off cost of the machinery every job needs — the JIT of the
 * whole path, V8 sizing its heap, the HTTP client, the first browser context, the CDP screenshot
 * and tracing paths. Measured 2026-08-31 across 200 chains: 125MB at boot, 149MB after ten
 * chains, then 149 -> 159MB over the remaining 190. Charging that first step to the leak detector
 * would report a 133% "leak" for a floor that is, from the first job onward, flat.
 *
 * This makes the test STRICTER, not laxer: a real per-chain leak still shows up over the other
 * 199 chains, and `nodeRssBootBytes` is reported anyway so a reader can check the warm-up cost
 * itself.
 */
const WARMUP_CHAINS = 1;

/**
 * Both ends of the RSS ratio are a MEDIAN over this many consecutive floors, not one reading.
 *
 * A single sample is not a floor. Measured 2026-08-31 over two 200-chain runs: the same chain
 * index read 157MB in one run and 218MB in the other, because a browser relaunch (every 50
 * contexts) can leave up to ~50MB of not-yet-collected garbage in the reading. One unlucky
 * sample at either end would then invent a 60% "leak" or hide a real one. A ten-sample median
 * is immune to that spike and still moves the moment the floor genuinely creeps: the pre-fix
 * leak of ~0.55MB per chain separates the two windows by ~100MB over 200 chains.
 */
const FLOOR_WINDOW = Math.max(1, Math.min(10, Math.floor(CHAINS / 4)));

/** A soak this short measures warm-up, not the floor — refuse rather than report a meaningless ratio. */
const MIN_SOAK_CHAINS = 4;

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

/**
 * The verb under the steps is deliberately a NAVIGATION and nothing else: the soak measures the
 * fleet's memory behaviour, not Playwright's click implementation. Every step reloads the same
 * `data:` page, which is also what makes consecutive frames byte-identical and exercises the
 * ring's dedup path the way a real form flow does.
 */
const soakVerb: VerbDefinition = {
  opKey: SOAK_OP_KEY,
  sentence: "Click on {element}",
  params: [],
  needsRendering: false,
  execute: async (ctx) => {
    const page = ctx.page as { goto: (url: string) => Promise<unknown> };
    await page.goto(SYNTHETIC_URL);
    return { ok: true };
  },
};

/**
 * Chromium processes visible on this box, by pid. Read from `/proc/<pid>/cmdline` rather than
 * from a process tree: a leaked renderer is re-parented to init the moment its browser dies, so
 * "still a child of ours" would report zero orphans by construction.
 */
function chromiumPids(): ReadonlySet<number> {
  const pids = new Set<number>();
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(join("/proc", entry, "cmdline"), "utf8");
    } catch {
      continue; // exited between readdir and read — a normal race, not a finding
    }
    if (/headless_shell|chrome-linux|chromium/u.test(cmdline)) pids.add(pid);
  }
  return pids;
}

/**
 * Root cannot launch a sandboxed chromium (see the file header). The opt-out is stated HERE, in
 * the test that depends on it, so no reader mistakes a green soak for a sandboxed one.
 */
async function launchSoakEngine(traceDir: string): Promise<PlaywrightBrowserEngine> {
  const rootHere = process.getuid?.() === 0;
  return launchPlaywrightEngine(rootHere ? { traceDir, sandbox: "off-root-dev-only" } : { traceDir });
}

/**
 * The worker holds ONE engine reference for its whole life, but the fleet replaces the browser
 * under it every 50 contexts. This indirection is what lets the soak recycle for real — closing
 * a browser and launching another — instead of merely counting how often it would have.
 */
function engineProxy(current: () => PlaywrightBrowserEngine): BrowserEngine {
  return {
    kind: "playwright",
    newChainContext: (options) => current().newChainContext(options),
    browserPid: () => current().browserPid(),
    contextsServed: () => current().contextsServed(),
    treeRssBytes: () => current().treeRssBytes(),
    crashed: () => current().crashed(),
    close: () => current().close(),
  };
}

const scratch = mkdtempSync(join(tmpdir(), "tk-soak-"));
let plane: FakeControlPlane;
let engine: PlaywrightBrowserEngine;
/** Chromium already running before this soak started — never counted as our orphan. */
let foreignChromium: ReadonlySet<number> = new Set();

beforeAll(async () => {
  foreignChromium = chromiumPids();
  plane = new FakeControlPlane();
  await plane.start();
  // No skip guard on a failed launch: this file only runs when someone asked for it with
  // TESTKITE_SOAK=1, and a soak that quietly skips is worse evidence than no soak at all.
  engine = await launchSoakEngine(join(scratch, "traces"));
});

afterAll(async () => {
  await plane.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(process.env["TESTKITE_SOAK"] !== "1")(`soak ${CHAINS} synthetic chains`, () => {
  it(
    "holds every RSS ceiling, leaks no context and leaves no orphan chromium",
    async () => {
      expect(CHAINS).toBeGreaterThanOrEqual(MIN_SOAK_CHAINS);
      const plan = buildSyntheticPlan(CHAINS, SOAK_STEPS_PER_CHAIN);
      const client = new HttpControlPlaneClient({ baseUrl: plane.url, bootstrapToken: FAKE_BOOTSTRAP_TOKEN });
      await client.register({ workerId: "soak-w1", hostname: "soak-host", lane: "batch", capacity: 4 });

      const uploader = new RecordingUploader();
      /**
       * A holder, not two `let`s: TypeScript keeps narrowing a local variable that is only ever
       * assigned inside a callback, and would read `last` below as `never`. Property reads are
       * re-widened after any call, which is exactly the truth here — `runOnce()` reassigns both.
       */
      const chainContext: { live: EngineContextHandle | null; last: EngineContextHandle | null } = {
        live: null,
        last: null,
      };

      const worker = new Worker({
        client,
        engine: engineProxy(() => engine),
        ring: (scratchKey, policy) => new ScreenshotRing({ dir: join(scratch, scratchKey), capacity: 50, policy }),
        uploader,
        quarantine: new QuarantineDecider(
          new QuarantineLedger(),
          new FleetBreaker({ windowMs: 600_000, minSamples: 100, oomRatePct: 50, now: () => Date.now() }),
        ),
        oom: new OomReporter(new FakeMemoryLimiter()),
        monitor: new ContextMemoryMonitor({ sampleRss: () => null, onAction: () => {} }),
        onChainContext: (handle) => {
          chainContext.live = handle;
          if (handle !== null) chainContext.last = handle;
        },
        resolveVerb: () => soakVerb,
        now: () => Date.now(),
        log: () => {},
        workerId: "soak-w1",
        lane: "batch",
        maxContexts: MEMORY.contextsPerWorker.batch,
        containerLimitBytes: MEMORY.containerLimitMb.batch * MB,
        traceDir: join(scratch, "traces"),
        jobHeartbeatMs: 5_000,
      });

      const nodeRssBootBytes = readRssBytes(process.pid) ?? 0;
      /** One RSS floor per chain, each read BETWEEN jobs — the two windows below come from this. */
      const floors: number[] = [];
      let browserTreeRssPeakBytes = 0;
      let contextsLeaked = 0;
      let recycles = 0;
      let contextsOnThisBrowser = 0;
      let browserStartedAtMs = Date.now();
      const durations: number[] = [];

      for (const chain of plan.chains) {
        const startedAt = Date.now();
        plane.nextJob = { chainKey: chain.chainKey, plan };
        expect(await worker.runOnce()).toBe("ran");
        durations.push(Date.now() - startedAt);

        // The chain is over, so its context must be gone from BOTH sides: the worker released it
        // (`onChainContext(null)`) and the engine no longer attributes a byte of renderer RSS to
        // it. A handle that is still open, or an id the engine still knows, is the leak.
        const closed = chainContext.last;
        if (
          chainContext.live !== null ||
          closed === null ||
          !closed.closed ||
          engine.contextRssBytes(closed.contextId) !== 0
        ) {
          contextsLeaked += 1;
        }

        // THE FLOOR, read here and nowhere else: the chain's context, ring and trace are gone,
        // the next job has not been claimed, and — deliberately — the browser has not been
        // recycled yet. `containerRecycleReason` defines its leak detector on exactly this
        // reading ("RSS measured BETWEEN jobs, when nothing should still be held"), and taking it
        // before the relaunch keeps a browser teardown's transient out of the sample. The cost of
        // a relaunch is not hidden by that: the next chain's floor is read after it.
        floors.push(readRssBytes(process.pid) ?? 0);

        contextsOnThisBrowser += 1;
        browserTreeRssPeakBytes = Math.max(browserTreeRssPeakBytes, engine.treeRssBytes());

        const reason = browserRecycleReason(
          {
            contextsServed: contextsOnThisBrowser,
            startedAtMs: browserStartedAtMs,
            rssBytes: engine.treeRssBytes(),
            crashed: engine.crashed(),
          },
          Date.now(),
        );
        if (reason !== null) {
          // A real recycle, not a counter: the browser is torn down and replaced, which is also
          // what puts the orphan assertion below in front of FIVE browser deaths instead of one.
          await engine.close();
          engine = await launchSoakEngine(join(scratch, "traces"));
          recycles += 1;
          contextsOnThisBrowser = 0;
          browserStartedAtMs = Date.now();
        }

        // The harness's own recorder is not the system under test: 200 chains leave ~2000 request
        // bodies in it, and letting that grow would charge the fake plane's bookkeeping to node's
        // RSS floor and call the fleet a leak.
        plane.calls.length = 0;
      }

      await engine.close();
      await new Promise((resolve) => setTimeout(resolve, ORPHAN_SETTLE_MS));

      const orphanChromiumAfter = [...chromiumPids()].filter((pid) => !foreignChromium.has(pid)).length;
      const report: SoakReport = {
        chains: CHAINS,
        nodeRssBootBytes,
        // The first window starts after the warm-up chain; the last window ends on the last chain.
        nodeRssStartBytes: median(floors.slice(WARMUP_CHAINS, WARMUP_CHAINS + FLOOR_WINDOW)),
        nodeRssEndBytes: median(floors.slice(-FLOOR_WINDOW)),
        nodeRssFinalBytes: readRssBytes(process.pid) ?? 0,
        browserTreeRssPeakBytes,
        orphanChromiumAfter,
        contextsLeaked,
        msPerChainP50: median(durations),
        recycles,
      };
      // Pasted verbatim into tasks/M3-orchestration-fleet.md as the milestone's exit evidence.
      console.log(`SOAK REPORT ${JSON.stringify(report)}`);

      // Every chain reported a verdict, and none of them was an infra error: a soak whose chains
      // quietly failed would keep RSS flat for the least interesting reason imaginable.
      expect(worker.stats()).toMatchObject({ claimed: CHAINS, completed: CHAINS, infraFailures: 0 });
      // Retain-on-failure (§5.2): 200 green chains cost ZERO artifact PUTs.
      expect(uploader.uploads).toHaveLength(0);

      // 1. Node's RSS floor must not creep — this is the old system's slow death, made impossible.
      //    Both ends are windowed medians of floors taken BETWEEN jobs (see FLOOR_WINDOW).
      expect((report.nodeRssEndBytes / report.nodeRssStartBytes) * 100).toBeLessThan(
        MEMORY.recycle.containerRssFloorGrowthPct,
      );
      // 2. The chromium tree never approaches the L1 container ceiling.
      expect(browserTreeRssPeakBytes).toBeLessThan(MEMORY.containerLimitMb.batch * MB);
      // 3. No context survives its chain.
      expect(contextsLeaked).toBe(0);
      // 4. No chromium process survives its browser (measured after the settle window above).
      expect(orphanChromiumAfter).toBe(0);
    },
    SOAK_TIMEOUT_MS,
  );
});
