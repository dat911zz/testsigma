import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetryableInfraError } from "@testkite/contract";
import { describe, expect, it } from "vitest";
import { FakeMemoryLimiter } from "../../src/memory/limiter.js";
import { OomReporter } from "../../src/memory/oom-reporter.js";
import { OOM_SCORE_CHROMIUM, OOM_SCORE_NODE, setOomScoreAdj } from "../../src/memory/oom-score.js";

const MB = 1024 * 1024;

function fakeProc(pid: number): string {
  const root = mkdtempSync(join(tmpdir(), "tk-oomproc-"));
  mkdirSync(join(root, String(pid)));
  writeFileSync(join(root, String(pid), "oom_score_adj"), "0\n");
  return root;
}

describe("setOomScoreAdj", () => {
  it("writes the chromium value so the kernel prefers killing the browser", () => {
    const root = fakeProc(7);
    expect(setOomScoreAdj(7, OOM_SCORE_CHROMIUM, root)).toBe("applied");
    expect(readFileSync(join(root, "7", "oom_score_adj"), "utf8").trim()).toBe("500");
  });

  it("writes the node value so the kernel spares the reporter", () => {
    const root = fakeProc(8);
    expect(setOomScoreAdj(8, OOM_SCORE_NODE, root)).toBe("applied");
    expect(readFileSync(join(root, "8", "oom_score_adj"), "utf8").trim()).toBe("-500");
  });

  it("reports denied instead of throwing when the capability is missing", () => {
    // No such pid => the write fails exactly like an EACCES from a missing CAP_SYS_RESOURCE.
    expect(setOomScoreAdj(999_999, OOM_SCORE_NODE, mkdtempSync(join(tmpdir(), "tk-empty-")))).toBe(
      "denied",
    );
  });

  it("keeps the two values as separate constants (node negative, chromium positive)", () => {
    expect(OOM_SCORE_NODE).toBe(-500);
    expect(OOM_SCORE_CHROMIUM).toBe(500);
  });
});

describe("OomReporter", () => {
  it("finds no kill when the oom_kill counter did not move", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.setCurrent(900 * MB);
    expect(reporter.check(null).killed).toBe(false);
  });

  it("detects a kernel kill from the counter delta and carries the cgroup peak", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.setPeak(1_728_053_248);
    limiter.raiseOomKill();
    const finding = reporter.check({ contextId: "ctx-3", rssBytes: 520 * MB });
    expect(finding.killed).toBe(true);
    expect(finding.oomKillDelta).toBe(1);
    expect(finding.peakRssBytes).toBe(1_728_053_248);
    expect(finding.blamedContextId).toBe("ctx-3");
  });

  it("blames no context when the kill lands before any per-context measurement", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.raiseOomKill();
    const finding = reporter.check(null);
    expect(finding.killed).toBe(true);
    expect(finding.blamedContextId).toBeNull();
  });

  it("re-baselines after a check so the same kill is never reported twice", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.raiseOomKill();
    expect(reporter.check(null).killed).toBe(true);
    expect(reporter.check(null).killed).toBe(false);
  });

  /**
   * The whole point of this class is that the KERNEL, not the stack trace, decides whether
   * chromium was killed. When the cgroup cannot be answered for, "no kill" is a guess, and a
   * guess dressed as `killed: false` turns a real OOM into a healthy-looking chain.
   */
  it("does not claim there was no kill when the cgroup could not be read", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.setUnreadable("memory.events unreadable (EISDIR)");
    const finding = reporter.check(null);
    expect(finding.unreadable).toMatch(/EISDIR/);
    expect(finding.killed).toBe(false); // false means UNKNOWN here, and `unreadable` says so
  });

  it("carries an unreadable BASELINE forward: a delta against a number nobody read is not evidence", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    limiter.setUnreadable("memory.events is absent (ENOENT)");
    reporter.baseline();
    limiter.setUnreadable(null);
    limiter.raiseOomKill();
    const finding = reporter.check({ contextId: "ctx-3", rssBytes: 1 });
    expect(finding.unreadable).toMatch(/ENOENT/);
    expect(finding.killed).toBe(false);
    expect(finding.blamedContextId).toBeNull(); // never blame a context on a guess
  });

  it("says nothing is unreadable on the happy path, so the flag stays meaningful", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.raiseOomKill();
    const finding = reporter.check(null);
    expect(finding.unreadable).toBeNull();
    expect(finding.killed).toBe(true);
  });

  it("maps a finding to a RETRYABLE browser_oom infra error carrying peakRss", () => {
    const limiter = new FakeMemoryLimiter();
    const reporter = new OomReporter(limiter);
    reporter.baseline();
    limiter.setPeak(1_728_053_248);
    limiter.raiseOomKill();
    const err = reporter.toInfraError(reporter.check({ contextId: "ctx-3", rssBytes: 520 * MB }));
    expect(err).toBeInstanceOf(RetryableInfraError);
    expect(err.code).toBe("browser_oom");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("1728053248");
    expect(err.message).toContain("ctx-3");
  });
});
