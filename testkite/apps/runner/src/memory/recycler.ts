/**
 * Recycling (docs/SYSTEM_DESIGN.md §5): browser every 50 contexts / 45 min / 1.4GB / crash;
 * container every 500 jobs / 12h / RSS floor above 130% of baseline.
 *
 * This is the answer to the old system's slow death: a process that lives forever accumulates
 * forever. Nothing here is a heuristic invented on the spot — every number comes from
 * MEMORY.recycle, which is also what the container manifest is generated from.
 *
 * The RSS-floor rule is a LEAK DETECTOR, not a ceiling: it compares the floor between jobs
 * (when nothing should be held) against the floor at boot. The 2026-08-29 soak measured the
 * real drift at 87.0MB -> 95.3MB over 30 chains and then flat — 110%, comfortably under 130%.
 */
import { MEMORY } from "../memory-governance.js";

export type BrowserRecycleReason = "contexts" | "age" | "rss" | "crash" | null;

export interface BrowserLifetime {
  readonly contextsServed: number;
  readonly startedAtMs: number;
  readonly rssBytes: number;
  readonly crashed: boolean;
}

export function browserRecycleReason(lifetime: BrowserLifetime, nowMs: number): BrowserRecycleReason {
  if (lifetime.crashed) return "crash";
  if (lifetime.contextsServed >= MEMORY.recycle.browserAfterContexts) return "contexts";
  if (nowMs - lifetime.startedAtMs >= MEMORY.recycle.browserAfterMinutes * 60_000) return "age";
  if (lifetime.rssBytes >= MEMORY.recycle.browserAboveRssMb * 1024 * 1024) return "rss";
  return null;
}

export type ContainerRecycleReason = "jobs" | "age" | "rss-floor-growth" | null;

export interface ContainerLifetime {
  readonly jobsDone: number;
  readonly startedAtMs: number;
  /** RSS measured BETWEEN jobs, when nothing should still be held. */
  readonly rssFloorBytes: number;
  readonly baselineRssFloorBytes: number;
}

export function containerRecycleReason(lifetime: ContainerLifetime, nowMs: number): ContainerRecycleReason {
  if (lifetime.jobsDone >= MEMORY.recycle.containerAfterJobs) return "jobs";
  if (nowMs - lifetime.startedAtMs >= MEMORY.recycle.containerAfterHours * 3_600_000) return "age";
  if (lifetime.baselineRssFloorBytes > 0) {
    const growthPct = (lifetime.rssFloorBytes / lifetime.baselineRssFloorBytes) * 100;
    if (growthPct >= MEMORY.recycle.containerRssFloorGrowthPct) return "rss-floor-growth";
  }
  return null;
}
