/**
 * The ONE source of RSS numbers in the runner.
 *
 * Spike (2026-08-29, 1000 reads each): process.memoryUsage.rss() 6ms but only ever reads THIS
 * process; /proc/<pid>/statm 7ms and reads ANY pid — which is what per-context attribution
 * needs, since a BrowserContext's memory lives in a separate renderer process;
 * /proc/<pid>/status 12ms plus a regex. All three agreed within 0.5MB, so the cheapest
 * pid-agnostic one wins.
 *
 * `procRoot` is injectable so tests build a fake /proc tree instead of racing live processes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errnoOf } from "./errno.js";

/** x86_64 page size. Chromium and Node both run on 4K pages on every host we target. */
export const PAGE_SIZE_BYTES = 4096;

export function readRssBytes(pid: number, procRoot = "/proc"): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), "statm"), "utf8");
  } catch (err) {
    // ONLY "the process is gone" is absorbed — that is the normal race between taking a pid list
    // and reading it. Any other errno (EACCES, EISDIR, EIO) says the assumption behind /proc is
    // broken, and swallowing it into null would make `sumRssBytes` fold it into 0: the L2/L3
    // ceilings would then measure a browser tree smaller than the real one and never fire.
    const code = errnoOf(err);
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw err;
  }
  const resident = raw.trim().split(/\s+/)[1];
  // Strict digits, not `parseInt`: parseInt reads "21700abc" as 21700, so a corrupt statm would be
  // believed rather than reported as unparseable.
  if (resident === undefined || !/^\d+$/.test(resident)) return null;
  const pages = Number(resident);
  if (!Number.isSafeInteger(pages)) return null;
  return pages * PAGE_SIZE_BYTES;
}

/**
 * Total RSS of the pids still alive. A pid that exited contributes 0; a pid whose statm cannot be
 * read PROPAGATES, because a silent undercount here is a ceiling that never fires.
 */
export function sumRssBytes(pids: readonly number[], procRoot = "/proc"): number {
  let total = 0;
  for (const pid of pids) total += readRssBytes(pid, procRoot) ?? 0;
  return total;
}
