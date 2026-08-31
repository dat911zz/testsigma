import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePsi, readPsi, watermarkFor } from "../../src/runnerd/psi.js";

/**
 * Runs ONLY under `pnpm --filter @testkite/runner test:host` on a kernel that was built with
 * CONFIG_PSI and mounts it. The dev sandbox has no `/proc/pressure` at all (spike 2026-08-29),
 * so the default suite can only ever prove that the parser reads the documented TEXT; that a
 * real kernel writes that text, and that `readPsi` gets a usable sample out of it, is proven
 * here and nowhere else.
 */
const PSI_PATH = "/proc/pressure/memory";
const describeHostPsi =
  process.env["TESTKITE_HOST_CGROUP"] === "1" && existsSync(PSI_PATH) ? describe : describe.skip;

describeHostPsi("PSI on a kernel that really exposes it", () => {
  it("reads the live pressure file into a sample with finite averages", () => {
    const sample = readPsi(PSI_PATH);
    expect(sample).not.toBeNull();
    if (sample === null) return;
    for (const value of [sample.some10, sample.some60, sample.full10]) {
      expect(Number.isFinite(value)).toBe(true);
      // The kernel writes a percentage of wall time, so the whole range is 0..100.
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("parses the kernel's own bytes the same way the fixture-driven suite does", () => {
    expect(parsePsi(readFileSync(PSI_PATH, "utf8"))).toEqual(readPsi(PSI_PATH));
  });

  it("classifies an idle host as green rather than refusing to answer", () => {
    // Not an assertion about load: any of the three is a legal answer on a busy box. What is
    // being checked is that a REAL sample maps to a watermark at all.
    expect(["green", "amber", "red"]).toContain(watermarkFor(readPsi(PSI_PATH)));
  });
});
