/**
 * L2 of the four memory ceilings (docs/SYSTEM_DESIGN.md §5): a NESTED cgroup holding only the
 * browser, with memory.max = container − MEMORY.browserCgroupReserveMb. When the browser blows
 * through it, the kernel kills a process INSIDE that cgroup — Node, which lives outside it,
 * survives, reads memory.events, blames the largest context and reports browser_oom itself.
 *
 * Two implementations on purpose:
 *  - CgroupV2MemoryLimiter — production hosts (systemd 255, default-hierarchy=unified).
 *  - FakeMemoryLimiter — every unit test. The 2026-08-29 spike showed the dev sandbox runs a
 *    cgroup v1 HYBRID whose unified hierarchy carries only the hugetlb controller, so
 *    memory.max/memory.events/memory.peak do not exist there at all. The mechanism itself was
 *    proved on that box through the v1 API (200MB cap ⇒ kernel killed the process inside the
 *    cgroup, parent survived and read oom_kill=1), so what is faked here is the FILE INTERFACE,
 *    not the behaviour.
 *
 * WHAT PROVES WHAT. `test/memory/limiter.test.ts` reads a directory of plain files shaped like a
 * cgroup node, so it proves the FILE INTERFACE only — the paths, the parsing, and which read
 * failures are survivable. `test/host/cgroup-v2.test.ts` reads a REAL unified hierarchy, and is
 * skipped wherever `detectCgroupV2Memory` is false (the dev sandbox, where the unified hierarchy
 * carries only hugetlb), so it proves the paths exist on a production host — not that the kernel
 * enforces them. That the ENFORCEMENT works is the v1 spike above, and nothing in CI re-proves it.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY } from "../memory-governance.js";
import { errnoOf } from "./errno.js";

export interface MemorySnapshot {
  /** Number.POSITIVE_INFINITY when the cgroup is unlimited (`memory.max` == "max"). */
  readonly limitBytes: number;
  readonly currentBytes: number;
  readonly peakBytes: number;
  readonly oomKillCount: number;
  /** memory.events `high` — how often the soft ceiling throttled the cgroup. */
  readonly highCount: number;
  /**
   * Null when every cgroup file was read. Otherwise the reason the first one was not, and every
   * number above is then a DEFAULT rather than a measurement: `oomKillCount: 0` means "nothing was
   * read", never "the kernel reports no kill". Without this flag a swallowed read error is
   * indistinguishable from a healthy cgroup, which is how a real OOM gets reported as a healthy
   * chain — see `OomReporter`, the one consumer that must never guess.
   */
  readonly unreadable: string | null;
}

export interface MemoryLimiter {
  readonly kind: "cgroup-v2" | "fake";
  setLimit(bytes: number): void;
  attach(pid: number): void;
  read(): MemorySnapshot;
}

/** memory.max for the nested browser cgroup = container limit − the reserve Node needs to survive. */
export function browserCgroupLimitBytes(containerLimitBytes: number): number {
  const reserve = MEMORY.browserCgroupReserveMb * 1024 * 1024;
  if (containerLimitBytes <= reserve) {
    throw new Error(
      `container limit ${containerLimitBytes}B is not larger than the ${reserve}B reserve — Node would have no memory left to report the OOM`,
    );
  }
  return containerLimitBytes - reserve;
}

export class CgroupV2MemoryLimiter implements MemoryLimiter {
  readonly kind = "cgroup-v2" as const;
  readonly #dir: string;

  constructor(cgroupDir: string) {
    this.#dir = cgroupDir;
  }

  setLimit(bytes: number): void {
    writeFileSync(join(this.#dir, "memory.max"), String(Math.floor(bytes)));
  }

  attach(pid: number): void {
    // cgroup.procs takes ONE pid per write; appending is how the kernel wants it.
    appendFileSync(join(this.#dir, "cgroup.procs"), `${pid}\n`);
  }

  read(): MemorySnapshot {
    const events = this.#readText("memory.events");
    const current = this.#readText("memory.current");
    const peak = this.#readText("memory.peak");
    const max = this.#readText("memory.max");
    return {
      limitBytes: parseLimit(max.text),
      currentBytes: parseNumber(current.text),
      peakBytes: parseNumber(peak.text),
      oomKillCount: eventCount(events.text ?? "", "oom_kill"),
      highCount: eventCount(events.text ?? "", "high"),
      unreadable: [events, current, peak, max].find((a) => a.reason !== null)?.reason ?? null,
    };
  }

  /**
   * One cgroup file, and WHY it could not be read when it could not.
   *
   * ENOENT is the legitimate failure — the cgroup was removed under us when the browser exited and
   * its scope was reaped — and it is still reported, because the numbers are just as absent either
   * way. Every other errno (EACCES, EISDIR, EIO) means the mount or the permissions are not what
   * this class assumes, and flattening that into an empty string, as this used to, produced
   * `0 current, 0 oom_kill`: a snapshot of a perfectly healthy cgroup that nobody read.
   */
  #readText(name: string): ReadAttempt {
    try {
      return { text: readFileSync(join(this.#dir, name), "utf8"), reason: null };
    } catch (err) {
      const code = errnoOf(err) ?? "unknown";
      const how = code === "ENOENT" ? "is absent" : "could not be read";
      return { text: null, reason: `${name} ${how} (${code})` };
    }
  }
}

/** The text of one cgroup file, or the reason there is none. */
interface ReadAttempt {
  readonly text: string | null;
  readonly reason: string | null;
}

/** 0 for an unread or unparseable file — the caller learns which from `MemorySnapshot.unreadable`. */
function parseNumber(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseLimit(raw: string | null): number {
  if (raw === null) return Number.POSITIVE_INFINITY;
  const text = raw.trim();
  if (text === "max") return Number.POSITIVE_INFINITY;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** `memory.events` is `key value` per line; a missing key means zero, never NaN. */
function eventCount(events: string, key: string): number {
  for (const line of events.split("\n")) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key) {
      const n = Number.parseInt(value ?? "", 10);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

export class FakeMemoryLimiter implements MemoryLimiter {
  readonly kind = "fake" as const;
  #limit = Number.POSITIVE_INFINITY;
  #current = 0;
  #peak = 0;
  #oomKill = 0;
  #high = 0;
  #unreadable: string | null = null;
  readonly attachedPids: number[] = [];

  setLimit(bytes: number): void {
    this.#limit = bytes;
  }

  attach(pid: number): void {
    this.attachedPids.push(pid);
  }

  read(): MemorySnapshot {
    return {
      limitBytes: this.#limit,
      currentBytes: this.#current,
      peakBytes: this.#peak,
      oomKillCount: this.#oomKill,
      highCount: this.#high,
      unreadable: this.#unreadable,
    };
  }

  /** Scripts a cgroup that cannot be answered for, so a test can prove nobody guesses from it. */
  setUnreadable(reason: string | null): void {
    this.#unreadable = reason;
  }

  setCurrent(bytes: number): void {
    this.#current = bytes;
    if (bytes > this.#peak) this.#peak = bytes;
  }

  setPeak(bytes: number): void {
    this.#peak = bytes;
  }

  raiseOomKill(by = 1): void {
    this.#oomKill += by;
  }

  raiseHigh(by = 1): void {
    this.#high += by;
  }
}

/**
 * True only when the unified hierarchy actually carries the memory controller. On the dev
 * sandbox this returns FALSE (controllers = "hugetlb"), which is exactly what gates the
 * host-only cgroup tests instead of letting them fail confusingly.
 */
export function detectCgroupV2Memory(cgroupRoot = "/sys/fs/cgroup"): boolean {
  try {
    return readFileSync(join(cgroupRoot, "cgroup.controllers"), "utf8")
      .split(/\s+/)
      .includes("memory");
  } catch {
    return false;
  }
}
