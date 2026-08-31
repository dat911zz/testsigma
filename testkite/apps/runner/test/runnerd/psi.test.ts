/**
 * SCOPE — what this file can and cannot prove.
 *
 * `/proc/pressure/memory` DOES NOT EXIST in the dev sandbox (spike 2026-08-29), so every case
 * here drives the parser with the kernel's literal text instead of the kernel. That proves the
 * FORMAT is read correctly and that a missing file degrades to "unknown", and nothing more.
 * That a real kernel's pressure file parses and that its numbers move under memory load is
 * proven only by `test/host/psi.test.ts` under `pnpm --filter @testkite/runner test:host`.
 */
import { describe, expect, it } from "vitest";
import { parsePsi, PSI_AMBER_PCT, PSI_RED_PCT, readPsi, watermarkFor } from "../../src/runnerd/psi.js";

/** The exact shape the kernel writes to /proc/pressure/memory (linux/Documentation/accounting/psi.rst). */
const HEALTHY =
  "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
const STRESSED =
  "some avg10=42.31 avg60=18.02 avg300=4.11 total=91827364\nfull avg10=12.50 avg60=3.00 avg300=0.40 total=1827364\n";
const WARM =
  "some avg10=15.00 avg60=9.00 avg300=1.00 total=100\nfull avg10=1.00 avg60=0.10 avg300=0.00 total=10\n";

/** A pressure file that carries only the `some` line — the shape older kernels expose for CPU. */
const SOME_ONLY = "some avg10=1.00 avg60=0.50 avg300=0.10 total=42\n";

describe("parsePsi", () => {
  it("parses a healthy sample", () => {
    expect(parsePsi(HEALTHY)).toEqual({ some10: 0, some60: 0, full10: 0 });
  });

  it("parses a stressed sample", () => {
    expect(parsePsi(STRESSED)).toEqual({ some10: 42.31, some60: 18.02, full10: 12.5 });
  });

  it("returns null for text that is not PSI rather than inventing zeros", () => {
    expect(parsePsi("not pressure data")).toBeNull();
  });

  it("returns null for an empty file", () => {
    expect(parsePsi("")).toBeNull();
  });

  it("returns null when the full line is missing instead of guessing it is zero", () => {
    expect(parsePsi(SOME_ONLY)).toBeNull();
  });

  it("returns null when an average is not a number the kernel would ever write", () => {
    expect(parsePsi("some avg10=1.2.3 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBeNull();
  });
});

describe("watermarkFor", () => {
  it("is green under the amber threshold", () => {
    expect(watermarkFor(parsePsi(HEALTHY))).toBe("green");
  });

  it("is amber between the amber and red thresholds", () => {
    expect(PSI_AMBER_PCT).toBe(10);
    expect(watermarkFor(parsePsi(WARM))).toBe("amber");
  });

  it("is amber exactly AT the amber threshold, and green just below it", () => {
    expect(watermarkFor({ some10: PSI_AMBER_PCT, some60: 0, full10: 0 })).toBe("amber");
    expect(watermarkFor({ some10: PSI_AMBER_PCT - 0.01, some60: 0, full10: 0 })).toBe("green");
  });

  it("is red at the red threshold", () => {
    expect(PSI_RED_PCT).toBe(30);
    expect(watermarkFor(parsePsi(STRESSED))).toBe("red");
    expect(watermarkFor({ some10: PSI_RED_PCT, some60: 0, full10: 0 })).toBe("red");
    expect(watermarkFor({ some10: PSI_RED_PCT - 0.01, some60: 0, full10: 0 })).toBe("amber");
  });

  it("treats a kernel WITHOUT PSI as green, not as red — an unknown is not an emergency", () => {
    expect(watermarkFor(null)).toBe("green");
  });
});

describe("readPsi", () => {
  it("returns null when the kernel does not expose PSI (the dev sandbox case)", () => {
    expect(readPsi("/proc/definitely-not-pressure")).toBeNull();
  });
});
