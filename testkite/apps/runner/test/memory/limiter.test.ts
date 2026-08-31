import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY } from "../../src/memory-governance.js";
import {
  browserCgroupLimitBytes,
  CgroupV2MemoryLimiter,
  detectCgroupV2Memory,
  FakeMemoryLimiter,
} from "../../src/memory/limiter.js";

const MB = 1024 * 1024;

describe("browserCgroupLimitBytes", () => {
  it("reserves exactly MEMORY.browserCgroupReserveMb for node and the rest of the container", () => {
    const container = MEMORY.containerLimitMb.batch * MB;
    expect(browserCgroupLimitBytes(container)).toBe(container - MEMORY.browserCgroupReserveMb * MB);
    // 3072MB container => 2672MB for the browser cgroup
    expect(browserCgroupLimitBytes(container) / MB).toBe(2672);
  });

  it("refuses a container limit smaller than the reserve rather than producing a negative limit", () => {
    expect(() => browserCgroupLimitBytes(100 * MB)).toThrow(/reserve/);
  });
});

describe("CgroupV2MemoryLimiter", () => {
  /** A directory shaped like a cgroup v2 node - the real kernel files are plain text too. */
  function fakeCgroupDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tk-cg-"));
    writeFileSync(join(dir, "memory.max"), "max\n");
    writeFileSync(join(dir, "memory.current"), "0\n");
    writeFileSync(join(dir, "memory.peak"), "0\n");
    writeFileSync(join(dir, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
    writeFileSync(join(dir, "cgroup.procs"), "");
    return dir;
  }

  it("writes the limit to memory.max in bytes", () => {
    const dir = fakeCgroupDir();
    new CgroupV2MemoryLimiter(dir).setLimit(2672 * MB);
    expect(readFileSync(join(dir, "memory.max"), "utf8").trim()).toBe(String(2672 * MB));
  });

  it("moves a pid by appending it to cgroup.procs", () => {
    const dir = fakeCgroupDir();
    new CgroupV2MemoryLimiter(dir).attach(4242);
    expect(readFileSync(join(dir, "cgroup.procs"), "utf8").trim()).toBe("4242");
  });

  it("parses memory.events oom_kill and memory.peak", () => {
    const dir = fakeCgroupDir();
    writeFileSync(join(dir, "memory.events"), "low 0\nhigh 3\nmax 12\noom 2\noom_kill 1\n");
    writeFileSync(join(dir, "memory.peak"), String(1_728_053_248));
    writeFileSync(join(dir, "memory.current"), String(900 * MB));
    writeFileSync(join(dir, "memory.max"), String(2672 * MB));
    const snap = new CgroupV2MemoryLimiter(dir).read();
    expect(snap.oomKillCount).toBe(1);
    expect(snap.highCount).toBe(3);
    expect(snap.peakBytes).toBe(1_728_053_248);
    expect(snap.currentBytes).toBe(900 * MB);
    expect(snap.limitBytes).toBe(2672 * MB);
  });

  it("reads an unlimited cgroup (memory.max=max) as Infinity, not NaN", () => {
    const dir = fakeCgroupDir();
    expect(new CgroupV2MemoryLimiter(dir).read().limitBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it("reports a fully readable cgroup as readable, so the flag means something", () => {
    expect(new CgroupV2MemoryLimiter(fakeCgroupDir()).read().unreadable).toBeNull();
  });

  /**
   * A swallowed read error used to come back as `0 current, 0 oom_kill` — indistinguishable from
   * a healthy cgroup, which is how a REAL kernel kill got reported as a healthy chain. The
   * failure is forced with a DIRECTORY named `memory.events` (EISDIR) rather than `chmod 000`:
   * this suite runs as uid 0 here, and root reads a 000 file just fine.
   */
  it("flags a cgroup file that exists but cannot be read, instead of reporting zeros", () => {
    const dir = fakeCgroupDir();
    rmSync(join(dir, "memory.events"));
    mkdirSync(join(dir, "memory.events"));
    const snap = new CgroupV2MemoryLimiter(dir).read();
    expect(snap.unreadable).toMatch(/memory\.events/);
    expect(snap.unreadable).toMatch(/EISDIR/);
    expect(snap.oomKillCount).toBe(0); // still 0 — but now it is labelled as "not measured"
  });

  it("names ENOENT separately: a cgroup removed under us is legitimate, a broken mount is not", () => {
    const snap = new CgroupV2MemoryLimiter(join(tmpdir(), "tk-cg-definitely-gone")).read();
    expect(snap.unreadable).toMatch(/ENOENT/);
  });
});

describe("FakeMemoryLimiter", () => {
  it("records the limit and reports what the test scripted", () => {
    const fake = new FakeMemoryLimiter();
    fake.setLimit(2672 * MB);
    fake.setCurrent(2_600 * MB);
    fake.setPeak(2_672 * MB);
    fake.raiseOomKill();
    const snap = fake.read();
    expect(snap.limitBytes).toBe(2672 * MB);
    expect(snap.currentBytes).toBe(2600 * MB);
    expect(snap.peakBytes).toBe(2672 * MB);
    expect(snap.oomKillCount).toBe(1);
    expect(fake.kind).toBe("fake");
  });

  it("reports readable by default and whatever unreadable reason a test scripts", () => {
    const fake = new FakeMemoryLimiter();
    expect(fake.read().unreadable).toBeNull();
    fake.setUnreadable("memory.events unreadable (EACCES)");
    expect(fake.read().unreadable).toBe("memory.events unreadable (EACCES)");
  });

  it("remembers attached pids so a test can assert the browser was placed in the nested cgroup", () => {
    const fake = new FakeMemoryLimiter();
    fake.attach(11);
    fake.attach(12);
    expect(fake.attachedPids).toEqual([11, 12]);
  });
});

describe("detectCgroupV2Memory", () => {
  it("is false when the unified hierarchy exposes no memory controller (the sandbox shape)", () => {
    const root = mkdtempSync(join(tmpdir(), "tk-cgroot-"));
    writeFileSync(join(root, "cgroup.controllers"), "hugetlb\n");
    expect(detectCgroupV2Memory(root)).toBe(false);
  });

  it("is true when memory is listed among the v2 controllers", () => {
    const root = mkdtempSync(join(tmpdir(), "tk-cgroot-"));
    writeFileSync(join(root, "cgroup.controllers"), "cpuset cpu io memory hugetlb pids\n");
    expect(detectCgroupV2Memory(root)).toBe(true);
  });

  it("is false when the file is absent altogether", () => {
    expect(detectCgroupV2Memory(join(tmpdir(), "definitely-not-a-cgroup-root"))).toBe(false);
  });
});
