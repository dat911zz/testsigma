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
  /**
   * True only when the kernel counter actually moved, on a cgroup that was actually read. FALSE
   * IS NOT "NO KILL" ON ITS OWN — read it together with `unreadable`.
   */
  readonly killed: boolean;
  /**
   * Null when the cgroup answered for itself. Otherwise why it did not, and `killed: false` above
   * means UNKNOWN rather than healthy. Reporting an unread cgroup as "no kill" is how a real OOM
   * came back as an ordinary chain failure — the kernel is the only witness this class has.
   */
  readonly unreadable: string | null;
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
  /** Why the baseline is not a measurement, when it is not. A delta against it proves nothing. */
  #baselineUnreadable: string | null = null;

  constructor(limiter: MemoryLimiter) {
    this.#limiter = limiter;
  }

  baseline(): void {
    const snap = this.#limiter.read();
    this.#baselineOomKill = snap.oomKillCount;
    this.#baselineUnreadable = snap.unreadable;
  }

  check(largestContext: ContextRss | null): OomFinding {
    const snap = this.#limiter.read();
    // EITHER end of the subtraction being unread makes the delta meaningless: a baseline of 0
    // that was never read against a real 1 invents a kill, and a real 1 against an unread 0
    // hides one. Both are reported as "unknown" rather than turned into a verdict.
    const unreadable = snap.unreadable ?? this.#baselineUnreadable;
    const delta = snap.oomKillCount - this.#baselineOomKill;
    this.#baselineOomKill = snap.oomKillCount; // re-baseline: one kill is reported exactly once
    this.#baselineUnreadable = snap.unreadable;
    const killed = unreadable === null && delta > 0;
    return {
      killed,
      unreadable,
      oomKillDelta: delta,
      peakRssBytes: snap.peakBytes,
      blamedContextId: killed ? (largestContext?.contextId ?? null) : null,
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
