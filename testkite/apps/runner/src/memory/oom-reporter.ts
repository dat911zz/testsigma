/**
 * The container DIAGNOSES ITSELF (docs/SYSTEM_DESIGN.md §5). When the nested browser cgroup
 * blows its ceiling, the kernel kills Chromium and Node stays alive — so Node is the one that
 * must turn a silent kill into a first-class, RETRYABLE infra error rather than letting the
 * job look like a mysterious crash or, worse, a product failure.
 *
 * The counter is read as a DELTA against a baseline taken when the chain started: an absolute
 * count would re-report every earlier kill on the same long-lived browser forever.
 */
import { RetryableInfraError } from "@testkite/contract";
import type { MemoryLimiter } from "./limiter.js";

export interface OomFinding {
  readonly killed: boolean;
  readonly oomKillDelta: number;
  /** Peak of the browser cgroup — the number the incident report is actually judged on. */
  readonly peakRssBytes: number;
  /** The context with the highest RSS at kill time: the one we blame. */
  readonly blamedContextId: string | null;
}

/** The largest context at kill time, as measured by the L3 monitor (Task 5). */
export interface ContextRss {
  readonly contextId: string;
  readonly rssBytes: number;
}

export class OomReporter {
  readonly #limiter: MemoryLimiter;
  #baselineOomKill = 0;

  constructor(limiter: MemoryLimiter) {
    this.#limiter = limiter;
  }

  baseline(): void {
    this.#baselineOomKill = this.#limiter.read().oomKillCount;
  }

  check(largestContext: ContextRss | null): OomFinding {
    const snap = this.#limiter.read();
    const delta = snap.oomKillCount - this.#baselineOomKill;
    this.#baselineOomKill = snap.oomKillCount; // re-baseline: one kill is reported exactly once
    return {
      killed: delta > 0,
      oomKillDelta: delta,
      peakRssBytes: snap.peakBytes,
      blamedContextId: delta > 0 ? (largestContext?.contextId ?? null) : null,
    };
  }

  toInfraError(finding: OomFinding): RetryableInfraError {
    const who = finding.blamedContextId ?? "unknown-context";
    return new RetryableInfraError(
      "browser_oom",
      `chromium was killed by the nested cgroup (oom_kill delta=${finding.oomKillDelta}); ` +
        `peakRss=${finding.peakRssBytes} bytes; largest context at kill time=${who}`,
    );
  }
}
