import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRssBytes, sumRssBytes, PAGE_SIZE_BYTES } from "../../src/memory/rss.js";

/** Builds a fake /proc tree so the test does not depend on any live process. */
function fakeProc(entries: Readonly<Record<number, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "tk-proc-"));
  for (const [pid, statm] of Object.entries(entries)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "statm"), statm);
  }
  return root;
}

describe("readRssBytes", () => {
  it("reads field 2 of statm and converts pages to bytes", () => {
    // size resident shared text lib data dt — resident = 21_700 pages = 84.8MB (the spike's node process)
    const root = fakeProc({ 100: "302645 21700 9858 1 0 995328 0\n" });
    expect(readRssBytes(100, root)).toBe(21_700 * PAGE_SIZE_BYTES);
  });

  it("returns null for a process that no longer exists instead of throwing", () => {
    const root = fakeProc({});
    expect(readRssBytes(999_999, root)).toBeNull();
  });

  it("returns null for a malformed statm rather than NaN", () => {
    const root = fakeProc({ 101: "garbage\n" });
    expect(readRssBytes(101, root)).toBeNull();
  });

  it("sums only the pids that are still alive", () => {
    const root = fakeProc({ 100: "1 1000 0 0 0 0 0\n", 101: "1 2000 0 0 0 0 0\n" });
    expect(sumRssBytes([100, 101, 999_999], root)).toBe(3_000 * PAGE_SIZE_BYTES);
  });
});

/**
 * The four tests above prove the PARSING against a fake /proc tree — they would stay green even
 * if field 2 of a real statm meant something other than resident pages, or if the default
 * `procRoot` were wrong. This block is the only place that reads a REAL kernel statm, and it is
 * the reason the fake above can be trusted: it cross-checks the same page against a second,
 * independent source (`process.memoryUsage.rss()`), which the spike measured as agreeing within
 * 0.5MB. Linux-only by nature — /proc does not exist elsewhere — hence the platform guard rather
 * than a `test:host` gate: CI runs Linux, so this DOES run in CI.
 */
describe.skipIf(process.platform !== "linux")("readRssBytes against the real /proc", () => {
  it("agrees with process.memoryUsage.rss() for this very process", () => {
    const fromStatm = readRssBytes(process.pid);
    const fromNode = process.memoryUsage.rss();
    expect(fromStatm).not.toBeNull();
    // The narrowing keeps the diff below type-safe without a non-null assertion.
    if (fromStatm === null) throw new Error("unreachable: asserted non-null above");
    expect(fromStatm).toBeGreaterThan(8 * 1024 * 1024);
    // 8MB of slack: the two reads happen microseconds apart, so only allocation noise separates them.
    expect(Math.abs(fromStatm - fromNode)).toBeLessThan(8 * 1024 * 1024);
  });
});
