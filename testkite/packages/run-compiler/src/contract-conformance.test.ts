/**
 * Proves `@testkite/contract`'s schema and the compiler's snapshot types haven't
 * drifted apart — using REAL DATA: every fixture in the golden suite.
 *
 * This is deliberately a one-directional test: anything the compiler can consume, the
 * API boundary must accept. The reverse direction (whatever the API accepts, the compiler
 * can also consume) is the compiler's own job.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSnapshotSchema } from "@testkite/contract";
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES } from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".golden.json"))
  .sort();

describe("contract ⇄ compiler conformance", () => {
  it("the fixture corpus is not empty (if empty, this test is meaningless)", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtureFiles)("fixture %s: its snapshot passes compileSnapshotSchema", (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
    const snapshot = (raw as { snapshot: unknown }).snapshot;
    const result = compileSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      throw new Error(`${file} failed the contract schema:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it("COMPILE_ERROR_CODES is re-exported from contract, not a local copy", async () => {
    const contract = await import("@testkite/contract");
    expect(COMPILE_ERROR_CODES).toBe(contract.COMPILE_ERROR_CODES);
  });
});
