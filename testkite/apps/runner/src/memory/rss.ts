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

/** x86_64 page size. Chromium and Node both run on 4K pages on every host we target. */
export const PAGE_SIZE_BYTES = 4096;

export function readRssBytes(pid: number, procRoot = "/proc"): number | null {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), "statm"), "utf8");
  } catch {
    return null; // the process exited between the snapshot and the read — a normal race, not an error
  }
  const resident = raw.trim().split(/\s+/)[1];
  if (resident === undefined) return null;
  const pages = Number.parseInt(resident, 10);
  if (!Number.isFinite(pages) || pages < 0) return null;
  return pages * PAGE_SIZE_BYTES;
}

export function sumRssBytes(pids: readonly number[], procRoot = "/proc"): number {
  let total = 0;
  for (const pid of pids) total += readRssBytes(pid, procRoot) ?? 0;
  return total;
}
