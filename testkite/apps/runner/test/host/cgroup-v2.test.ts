import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CgroupV2MemoryLimiter } from "../../src/memory/limiter.js";
import { describeHostCgroup, withTempCgroup } from "../harness/tmp-cgroup.js";

/**
 * Runs ONLY on a host whose unified hierarchy carries the memory controller
 * (`pnpm --filter @testkite/runner test:host`). This is the one place the v2 file names
 * themselves are exercised; everything else in the runner runs on FakeMemoryLimiter.
 */
describeHostCgroup("cgroup v2 memory pipe (host only)", () => {
  it("writes memory.max and reads it back", () => {
    withTempCgroup("/sys/fs/cgroup", (dir) => {
      const limiter = new CgroupV2MemoryLimiter(dir);
      limiter.setLimit(256 * 1024 * 1024);
      expect(readFileSync(`${dir}/memory.max`, "utf8").trim()).toBe(String(256 * 1024 * 1024));
      expect(limiter.read().limitBytes).toBe(256 * 1024 * 1024);
    });
  });

  it("exposes oom_kill and peak through the same snapshot shape the fake uses", () => {
    withTempCgroup("/sys/fs/cgroup", (dir) => {
      const snap = new CgroupV2MemoryLimiter(dir).read();
      expect(snap.oomKillCount).toBe(0);
      expect(snap.peakBytes).toBeGreaterThanOrEqual(0);
    });
  });
});
