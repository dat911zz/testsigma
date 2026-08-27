/**
 * 4 tầng trần bộ nhớ (docs/SYSTEM_DESIGN.md §5) — các hằng số là NGUỒN SỰ THẬT
 * cho cả manifest container (CI đối chiếu; manifest thiếu memory limit = fail).
 *
 * L0 host:    ts-workers.slice — MemoryHigh 80% / MemoryMax 88% RAM host
 * L1 container: 3GB batch (K=4) | 2GB interactive (K=2), pids 512, cpus 2.0
 * L2 browser:  cgroup lồng memory.max = container − 400MB;
 *              oom_score_adj node=−500 chromium=+500 → kernel giết ĐÚNG Chromium,
 *              node sống sót đọc memory.events và tự báo cáo.
 * L3 context:  350MB soft / 500MB hard, poll 5s.
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
  /** timeout lồng nhau chặt: action 15s < nav 30s < step 60s < chain clamp(90+12×steps, 180..900)s */
  timeoutsSec: { action: 15, nav: 30, step: 60, chainMin: 180, chainMax: 900, chainBase: 90, chainPerStep: 12 },
  /** Quarantine chain sau 2 lần OOM liên tiếp (poison-chain), có breaker khi cả fleet ốm. */
  quarantineAfterOomCount: 2,
} as const;
