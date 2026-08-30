/**
 * Helpers for tests that must touch the REAL `/proc`, not a temp directory shaped like it.
 *
 * A fake proc tree proves the code writes the right bytes to the right path; only the kernel
 * proves that the write is ALLOWED. The 2026-08-29 spike measured the split: raising
 * `oom_score_adj` needs no privilege, lowering it needs CAP_SYS_RESOURCE, which the dev sandbox
 * drops. So the raise path is exercised for real here, and the lower path is gated on the
 * capability instead of being asserted blind.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe } from "vitest";

/** Bit index of CAP_SYS_RESOURCE in the capability bitmask (uapi/linux/capability.h). */
const CAP_SYS_RESOURCE_BIT = 24n;

export function hasCapSysResource(procRoot = "/proc"): boolean {
  let status: string;
  try {
    status = readFileSync(`${procRoot}/self/status`, "utf8");
  } catch {
    return false; // not Linux, or no procfs — treat as "cannot lower"
  }
  const line = status.split("\n").find((l) => l.startsWith("CapEff:"));
  const hex = line?.split(/\s+/)[1];
  if (hex === undefined) return false;
  try {
    return ((BigInt(`0x${hex}`) >> CAP_SYS_RESOURCE_BIT) & 1n) === 1n;
  } catch {
    return false;
  }
}

/**
 * Host gate for the negative `oom_score_adj`: runs only under `test:host` on a box that really
 * holds CAP_SYS_RESOURCE. Skipping (rather than failing) elsewhere keeps a red meaning "the
 * code is wrong", never "this kernel drops a capability".
 */
export const describeHostCapSysResource =
  process.env["TESTKITE_HOST_CGROUP"] === "1" && hasCapSysResource() ? describe : describe.skip;

/**
 * Runs `fn` against a real, live child process — the shape the runner actually uses, since it
 * sets `oom_score_adj` on CHROMIUM's pid, never on its own. The child is killed afterwards.
 */
export async function withLiveProcess(fn: (pid: number) => void | Promise<void>): Promise<void> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const { pid } = child;
    if (pid === undefined) throw new Error("child process has no pid after the spawn event");
    await fn(pid);
  } finally {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
}
