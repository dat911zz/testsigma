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
 *    not the behaviour. The real v2 pipe is covered by test/host/cgroup-v2.test.ts.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY } from "../memory-governance.js";

export interface MemorySnapshot {
  /** Number.POSITIVE_INFINITY when the cgroup is unlimited (`memory.max` == "max"). */
  readonly limitBytes: number;
  readonly currentBytes: number;
  readonly peakBytes: number;
  readonly oomKillCount: number;
  /** memory.events `high` — how often the soft ceiling throttled the cgroup. */
  readonly highCount: number;
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
    return {
      limitBytes: this.#readLimit(),
      currentBytes: this.#readNumber("memory.current"),
      peakBytes: this.#readNumber("memory.peak"),
      oomKillCount: eventCount(events, "oom_kill"),
      highCount: eventCount(events, "high"),
    };
  }

  #readText(name: string): string {
    try {
      return readFileSync(join(this.#dir, name), "utf8");
    } catch {
      return "";
    }
  }

  #readNumber(name: string): number {
    const n = Number.parseInt(this.#readText(name).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  #readLimit(): number {
    const raw = this.#readText("memory.max").trim();
    if (raw === "max") return Number.POSITIVE_INFINITY;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  }
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
    };
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
