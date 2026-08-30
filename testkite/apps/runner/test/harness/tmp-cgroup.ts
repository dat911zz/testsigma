/**
 * Gate for tests that need a REAL cgroup v2 memory controller. On the dev sandbox the unified
 * hierarchy only carries hugetlb (spike 2026-08-29), so these tests must skip rather than fail:
 * a red that only means "wrong kernel config" trains people to ignore reds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { describe } from "vitest";
import { detectCgroupV2Memory } from "../../src/memory/limiter.js";

export const HOST_CGROUP_AVAILABLE =
  process.env["TESTKITE_HOST_CGROUP"] === "1" && detectCgroupV2Memory();

export const describeHostCgroup = HOST_CGROUP_AVAILABLE ? describe : describe.skip;

/** Creates a throwaway child cgroup under the current one and removes it afterwards. */
export function withTempCgroup(parent: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(`${parent}/tk-test-`);
  try {
    fn(dir);
  } finally {
    // cgroupfs answers rmdir on a cgroup that holds no processes and no children; Node's
    // rimraf tries rmdir FIRST and only walks children if that fails, so it never attempts
    // to unlink the kernel's interface files (which would be EPERM).
    rmSync(dir, { recursive: true, force: true });
  }
}
