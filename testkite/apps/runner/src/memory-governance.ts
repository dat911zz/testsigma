/**
 * The 4 memory ceilings (docs/SYSTEM_DESIGN.md §5) — these constants are the SOURCE OF TRUTH
 * for the container manifest too (CI cross-checks it; a manifest with no memory limit fails).
 *
 * L0 host:      ts-workers.slice — MemoryHigh 80% / MemoryMax 88% of host RAM
 * L1 container: 3GB batch (K=4) | 2GB interactive (K=2), pids 512, cpus 2.0
 * L2 browser:   nested cgroup, memory.max = container − 400MB;
 *               oom_score_adj node=−500 chromium=+500 → the kernel kills EXACTLY Chromium,
 *               node survives, reads memory.events and reports on itself.
 * L3 context:   350MB soft / 500MB hard, polled every 5s.
 */
export const MEMORY = {
  containerLimitMb: { batch: 3072, interactive: 2048 },
  contextsPerWorker: { batch: 4, interactive: 2 },
  browserCgroupReserveMb: 400, // memory.max = container − reserve
  contextSoftMb: 350,
  contextHardMb: 500,
  pollIntervalMs: 5_000,
  shedThresholdsPct: [75, 85, 92] as const, // stop-admitting / abort-largest / fail-youngest
  recycle: {
    browserAfterContexts: 50,
    browserAfterMinutes: 45,
    browserAboveRssMb: 1_400,
    containerAfterJobs: 500,
    containerAfterHours: 12,
    containerRssFloorGrowthPct: 130, // leak detector
  },
  /** Strictly nested timeouts: action 15s < nav 30s < step 60s < chain clamp(90+12×steps, 180..900)s */
  timeoutsSec: { action: 15, nav: 30, step: 60, chainMin: 180, chainMax: 900, chainBase: 90, chainPerStep: 12 },
  /** Quarantine a chain after 2 consecutive OOMs (poison chain), with a breaker for a sick fleet. */
  quarantineAfterOomCount: 2,
} as const;
