/**
 * The ONLY file in the runner that touches Playwright — and Playwright exists ONLY in the runner
 * image. `apps/core` never imports it (CI gate since M1): the browser lives in the fleet, not in
 * the API. That single boundary is why the old system's OOM class (docs/SYSTEM_DESIGN.md §1)
 * cannot be rewritten here.
 *
 * WHAT IS PROVEN WHERE. Every other engine consumer in this runner is tested against
 * `FakeBrowserEngine`, and a fake proves only the caller's own logic. The claims below are about
 * chromium itself, so they are asserted in `test/browser/playwright-engine.test.ts`, which
 * launches a real chromium-headless-shell and skips entirely where none exists.
 *
 * PER-CONTEXT MEMORY ATTRIBUTION, verified 2026-08-29: CDP `SystemInfo.getProcessInfo` returns
 * {type,id} for every browser process. Diffing the RENDERER set around newContext()+newPage()
 * yields exactly the renderer pids of the new context — ballooning one context moved only its own
 * renderer (84MB → 332MB) and left the neighbour at 84MB. RSS then comes from /proc/<pid>/statm
 * (`memory/rss.ts`). `Performance.getMetrics` is NOT a substitute: it reported JSHeapUsedSize of
 * 866KB while the same renderer held 84MB of RSS. GPU and network processes are deliberately NOT
 * attributed to anyone — they are shared infrastructure, and charging them to whichever chain
 * happened to start first would blame the innocent.
 *
 * WebP: Playwright's screenshot API has no WebP option; CDP `Page.captureScreenshot` does (§5.2).
 * Measured on the same viewport: WebP q70 2 362B vs JPEG q70 6 392B vs Playwright JPEG q70 9 503B.
 *
 * THE CHROMIUM SANDBOX (§5 spells it out: the chromium sandbox is ON, never `--no-sandbox`).
 * This is an OS-level isolation decision, so it is enforced rather than assumed: playwright-core
 * defaults `chromiumSandbox` to FALSE and appends `--no-sandbox` unless the option is exactly
 * `true` (lib/server/chromium/chromium.js:288). A launch that simply omits the option therefore
 * ships an UNSANDBOXED chromium. `resolveChromiumSandbox()` below makes `true` the default and
 * makes the opposite impossible to reach by accident.
 *
 * The one legitimate exception is a root dev/CI box: chromium's zygote refuses to sandbox as
 * root ("Running as root without --no-sandbox is not supported", zygote_host_impl_linux.cc:101,
 * re-measured 2026-08-30), so a root launch either opts out explicitly or does not start at all.
 * The opt-out is refused off root, which is where the fleet actually runs (worker container,
 * uid 10001) — production cannot fall back to `--no-sandbox` even if a config says so.
 *
 * Correction of record: the 2026-08-29 spike reported "launch ms=1118 noSandbox=false". That
 * reading was wrong — it recorded that the flag had not been passed BY US, not what chromium
 * received. Reading the launched browser's `/proc/<pid>/cmdline` shows `--no-sandbox` present.
 */
import type { OpContext } from "@testkite/verb-kit";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { sumRssBytes } from "../memory/rss.js";
import type { BrowserEngine, ChainContextOptions, EngineContextHandle } from "./engine.js";

/** Viewport of the fleet — the size every screenshot and every trace frame is captured at (§5.2). */
const VIEWPORT = { width: 1280, height: 720 } as const;

/** WebP quality used for the screenshot ring-buffer; the spike sized the buffer against q70. */
const SCREENSHOT_QUALITY = 70;

/**
 * A renderer process does not always appear in `SystemInfo.getProcessInfo` on the very same tick
 * the page is created. Poll briefly rather than concluding "this context owns no renderer" — an
 * empty pid set would silently switch L3 attribution off for that chain.
 */
const RENDERER_SETTLE_ATTEMPTS = 20;
const RENDERER_SETTLE_MS = 50;

interface ContextRecord {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly rendererPids: readonly number[];
  readonly tracing: boolean;
}

class PlaywrightHandle implements EngineContextHandle {
  readonly contextId: string;
  closed = false;
  readonly #engine: PlaywrightBrowserEngine;
  readonly #record: ContextRecord;

  constructor(engine: PlaywrightBrowserEngine, contextId: string, record: ContextRecord) {
    this.#engine = engine;
    this.contextId = contextId;
    this.#record = record;
  }

  opContext(stepTimeoutMs: number, log: (message: string) => void): OpContext {
    return { page: this.#record.page, stepTimeoutMs, log };
  }

  rendererPids(): readonly number[] {
    return this.#record.rendererPids;
  }

  async screenshotWebp(): Promise<Buffer> {
    const shot = await this.#record.cdp.send("Page.captureScreenshot", {
      format: "webp",
      quality: SCREENSHOT_QUALITY,
    });
    return Buffer.from(shot.data, "base64");
  }

  async stopTracing(destPath: string | null): Promise<void> {
    if (!this.#record.tracing) return;
    // No path ⇒ the trace is dropped: retain-on-failure means a green chain costs nothing (§5.1).
    await (destPath === null
      ? this.#record.context.tracing.stop()
      : this.#record.context.tracing.stop({ path: destPath }));
  }

  async close(): Promise<void> {
    // Idempotent: `run-chain.ts` closes in `finally`, and a caller that already closed on the
    // happy path must not turn the cleanup into a second failure.
    if (this.closed) return;
    this.closed = true;
    try {
      await this.#record.context.close();
    } finally {
      this.#engine.forget(this.contextId);
    }
  }
}

/**
 * `"on"` = chromium's OS-level sandbox, the only mode the fleet ever runs in.
 * `"off-root-dev-only"` = the escape hatch for a root dev/CI box, where chromium refuses to
 * sandbox at all. The name is the contract: it is accepted for uid 0 and nothing else.
 */
export type SandboxMode = "on" | "off-root-dev-only";

export interface LaunchOptions {
  readonly traceDir: string;
  /** Overrides the bundled chromium-headless-shell; used by the container image. */
  readonly headlessShellPath?: string;
  /** Defaults to `"on"`. Dropping the sandbox is never implicit — see `resolveChromiumSandbox`. */
  readonly sandbox?: SandboxMode;
}

/**
 * The sandbox decision, kept pure so it is provable without a browser — which matters because
 * the box that runs CI is precisely the box that cannot launch a sandboxed chromium.
 *
 * Off root the opt-out THROWS instead of degrading: a worker container (uid 10001) that was
 * somehow configured with `"off-root-dev-only"` must fail loudly at launch, not quietly run
 * every tenant's untrusted page with `--no-sandbox`. An unknown uid (`process.getuid`
 * unavailable) is treated as non-root for the same reason — refusing is the safe direction.
 */
export function resolveChromiumSandbox(mode: SandboxMode | undefined, uid: number): boolean {
  if (mode === undefined || mode === "on") return true;
  if (uid !== 0) {
    throw new Error(
      `chromium sandbox opt-out "off-root-dev-only" is accepted for uid 0 only, but this process runs as uid ${String(uid)}; ` +
        "the fleet runs unprivileged (docs/SYSTEM_DESIGN.md §5) and must keep the OS sandbox on",
    );
  }
  return false;
}

/** Printed on every unsandboxed launch: dropping OS isolation must never be a silent event. */
export const UNSANDBOXED_LAUNCH_WARNING =
  "[playwright-engine] chromium is launching WITHOUT its OS sandbox (--no-sandbox) because this " +
  "process is root; this is a dev/CI-only mode and nothing measured under it says anything about " +
  "the sandboxed fleet";

/** uid of this process, or -1 where the platform has none — never treated as root. */
function currentUid(): number {
  return process.getuid?.() ?? -1;
}

export class PlaywrightBrowserEngine implements BrowserEngine {
  readonly kind = "playwright" as const;
  readonly #browser: Browser;
  readonly #browserCdp: CDPSession;
  readonly #contexts = new Map<string, ContextRecord>();
  /** Whole-tree pid snapshot (browser + gpu + network + renderers), refreshed at every snapshot. */
  #treePids: readonly number[] = [];
  #browserPid: number | null = null;
  #served = 0;
  #crashed = false;
  /**
   * Context creation is serialised. Attribution is a DIFF of the renderer set, so two overlapping
   * `newChainContext()` calls on one browser would each see the other's renderer appear and could
   * blame the wrong chain. Serialising costs a few hundred milliseconds per context and buys an
   * attribution that cannot be raced.
   */
  #creations: Promise<unknown> = Promise.resolve();

  constructor(browser: Browser, browserCdp: CDPSession) {
    this.#browser = browser;
    this.#browserCdp = browserCdp;
    this.#browser.on("disconnected", () => {
      this.#crashed = true;
    });
  }

  async newChainContext(options: ChainContextOptions): Promise<EngineContextHandle> {
    const queued = this.#creations.then(
      () => this.#createContext(options),
      () => this.#createContext(options),
    );
    this.#creations = queued.catch(() => undefined);
    return queued;
  }

  /** The browser process pid — needed to place it in the nested cgroup and set oom_score_adj. */
  browserPid(): number | null {
    return this.#browserPid;
  }

  contextsServed(): number {
    return this.#served;
  }

  /**
   * RSS of the whole chromium tree, from the last pid snapshot. Snapshots are taken on every
   * context creation; between two chains the process set is stable (the 30-chain mini-soak stayed
   * at exactly 3 processes and ~212MB). A pid that died since the snapshot reads as 0, never as a
   * stale number: `readRssBytes` returns null when /proc/<pid> is gone.
   */
  treeRssBytes(): number {
    return sumRssBytes(this.#treePids);
  }

  crashed(): boolean {
    return this.#crashed;
  }

  /**
   * RSS of one context = the sum over ITS OWN renderer processes.
   *
   * 0 means "nothing left to attribute" — either the context was never opened here, or it was
   * closed, or its renderers died. The caller knows which contexts it opened, so it can tell the
   * three apart; this engine deliberately does not guess.
   */
  contextRssBytes(contextId: string): number {
    const record = this.#contexts.get(contextId);
    return record === undefined ? 0 : sumRssBytes(record.rendererPids);
  }

  /** @internal — a handle tells the engine it is gone; not part of `BrowserEngine`. */
  forget(contextId: string): void {
    this.#contexts.delete(contextId);
  }

  /** Test-only hook: runs JS inside one context's page so attribution can be proved. */
  async evaluateForTest(contextId: string, script: string): Promise<void> {
    const record = this.#contexts.get(contextId);
    if (record === undefined) throw new Error(`no such context: ${contextId}`);
    await record.page.evaluate(script);
  }

  async close(): Promise<void> {
    for (const record of this.#contexts.values()) {
      await record.context.close().catch(() => undefined);
    }
    this.#contexts.clear();
    await this.#browser.close();
  }

  /** Primes the pid snapshot so `browserPid()` answers before the first chain opens a context. */
  async refreshProcessInfo(): Promise<void> {
    await this.#rendererPids();
  }

  async #createContext(options: ChainContextOptions): Promise<EngineContextHandle> {
    const before = new Set(await this.#rendererPids());

    const context = await this.#browser.newContext({ viewport: { ...VIEWPORT }, baseURL: options.baseUrl });
    context.setDefaultTimeout(options.timeouts.actionMs);
    context.setDefaultNavigationTimeout(options.timeouts.navigationMs);
    if (options.trace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    const rendererPids = await this.#newRendererPids(before);
    const record: ContextRecord = { context, page, cdp, rendererPids, tracing: options.trace };
    this.#contexts.set(options.contextId, record);
    this.#served += 1;
    return new PlaywrightHandle(this, options.contextId, record);
  }

  /** Renderer pids that were not there before this context existed — the attribution itself. */
  async #newRendererPids(before: ReadonlySet<number>): Promise<readonly number[]> {
    for (let attempt = 0; attempt < RENDERER_SETTLE_ATTEMPTS; attempt += 1) {
      const fresh = (await this.#rendererPids()).filter((pid) => !before.has(pid));
      if (fresh.length > 0) return fresh;
      await new Promise((resolve) => setTimeout(resolve, RENDERER_SETTLE_MS));
    }
    return [];
  }

  /**
   * One CDP round-trip that answers two questions: which processes exist at all (the tree, for
   * L1/recycle) and which of them are renderers (the only ones a context can own).
   */
  async #rendererPids(): Promise<readonly number[]> {
    const info = await this.#browserCdp.send("SystemInfo.getProcessInfo");
    this.#treePids = info.processInfo.map((p) => p.id);
    this.#browserPid = info.processInfo.find((p) => p.type === "browser")?.id ?? this.#browserPid;
    return info.processInfo.filter((p) => p.type === "renderer").map((p) => p.id);
  }
}

export async function launchPlaywrightEngine(options: LaunchOptions): Promise<PlaywrightBrowserEngine> {
  // `chromiumSandbox` must be EXACTLY true or playwright appends `--no-sandbox` itself; passing
  // it explicitly is the whole difference between §5's promise and an unsandboxed fleet.
  const chromiumSandbox = resolveChromiumSandbox(options.sandbox, currentUid());
  if (!chromiumSandbox) console.warn(UNSANDBOXED_LAUNCH_WARNING);
  const browser = await chromium.launch({
    chromiumSandbox,
    ...(options.headlessShellPath === undefined
      ? { channel: "chromium-headless-shell" }
      : { executablePath: options.headlessShellPath }),
    tracesDir: options.traceDir,
  });
  const cdp = await browser.newBrowserCDPSession();
  const engine = new PlaywrightBrowserEngine(browser, cdp);
  await engine.refreshProcessInfo();
  return engine;
}
