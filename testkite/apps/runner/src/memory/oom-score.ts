/**
 * oom_score_adj is how the container TELLS THE KERNEL who to kill first (docs/SYSTEM_DESIGN.md
 * §5, L2): Chromium +500 so it is picked, Node -500 so the reporter survives to say what
 * happened. A kill that takes Node with it is the exact failure mode of the legacy system —
 * the job just vanished and nobody could name the cause.
 *
 * Two separate calls on purpose, never one "do both" helper: raising the score needs no
 * privilege, LOWERING it needs CAP_SYS_RESOURCE. The 2026-08-29 spike measured exactly that on
 * the dev sandbox — `+500` succeeded, `-500` returned EACCES even as uid 0, because
 * CAP_SYS_RESOURCE is dropped. A worker missing the capability must still run (chromium is
 * still the preferred victim); it just logs that Node is not protected.
 *
 * `procRoot` is injectable for the same reason as in rss.ts: tests build a fake /proc tree
 * instead of racing live processes. The real-kernel behaviour is covered separately by
 * test/memory/oom-score-proc.test.ts (raise) and test/host/oom-score.test.ts (lower).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Node: least attractive victim, so it lives to diagnose the kill. */
export const OOM_SCORE_NODE = -500;
/** Chromium: most attractive victim, so the kernel takes the browser and not the reporter. */
export const OOM_SCORE_CHROMIUM = 500;

export type OomScoreOutcome = "applied" | "denied";

export function setOomScoreAdj(pid: number, value: number, procRoot = "/proc"): OomScoreOutcome {
  try {
    writeFileSync(join(procRoot, String(pid), "oom_score_adj"), String(value));
    return "applied";
  } catch {
    // EACCES (capability dropped) and ENOENT (the process already exited) are both normal on a
    // worker box; neither is worth killing a run over, so the caller decides what to log.
    return "denied";
  }
}
