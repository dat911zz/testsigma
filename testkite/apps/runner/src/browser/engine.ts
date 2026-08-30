/**
 * The browser boundary. Everything above it (executor, worker, governance) is testable with
 * NO chromium at all; everything below it is one file (playwright-engine.ts) whose job is to
 * satisfy exactly this interface.
 *
 * ONE CONTEXT PER CHAIN is not an optimisation, it is the isolation model (§5): a chain's
 * cookies, storage and logged-in session live and die with its context, so a leaked session can
 * never reach the next tenant's chain. The handle therefore has no "reset" — only `close()`.
 *
 * A type is not a proof. This file only states what an engine must offer; that a REAL engine
 * behaves the way the doc comments claim (a closed context truly cancels an in-flight action,
 * a renderer pid truly belongs to one context, CDP truly returns WebP) is provable only against
 * chromium, in Task 12. Tests written against the fake never carry over to the real engine.
 */
import type { OpContext } from "@testkite/verb-kit";
import type { TimeoutBudget } from "../executor/timeouts.js";

export interface ChainContextOptions {
  readonly contextId: string;
  readonly baseUrl: string;
  readonly timeouts: TimeoutBudget;
  /** retain-on-failure: start the trace, then keep it only when the chain fails (§5.1). */
  readonly trace: boolean;
}

export interface EngineContextHandle {
  readonly contextId: string;
  readonly closed: boolean;
  /** The OpContext a verb-kit op runs against. `page` stays `unknown` in the verb contract. */
  opContext(stepTimeoutMs: number, log: (message: string) => void): OpContext;
  /** Renderer pids of THIS context — the L3 monitor sums their RSS. */
  rendererPids(): readonly number[];
  /** WebP q70 via CDP: the Playwright screenshot API cannot emit WebP (§5.2). */
  screenshotWebp(): Promise<Buffer>;
  /** destPath = keep the trace there; null = discard it (the chain passed). */
  stopTracing(destPath: string | null): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserEngine {
  readonly kind: "playwright" | "fake";
  newChainContext(options: ChainContextOptions): Promise<EngineContextHandle>;
  /** The browser process pid — needed to place it in the nested cgroup and set oom_score_adj. */
  browserPid(): number | null;
  contextsServed(): number;
  treeRssBytes(): number;
  crashed(): boolean;
  close(): Promise<void>;
}
