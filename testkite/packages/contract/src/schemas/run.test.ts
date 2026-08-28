import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES, compileDiagnosticSchema, runSchema } from "./run.js";

describe("COMPILE_ERROR_CODES", () => {
  it("holds all 12 M1 compiler codes", () => {
    expect(COMPILE_ERROR_CODES).toHaveLength(12);
    expect(COMPILE_ERROR_CODES).toContain("prereq_cycle");
    expect(COMPILE_ERROR_CODES).toContain("secret_ref_unknown");
  });

  it("order = the phase 1→5 flow, prereq_cycle comes first", () => {
    expect(COMPILE_ERROR_CODES[0]).toBe("prereq_cycle");
  });
});

describe("compileDiagnosticSchema", () => {
  it("accepts a diagnostic with stepOrdinal", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "verb_args_invalid",
      caseId: "checkout",
      stepOrdinal: 3,
      message: "missing param 'value'",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a diagnostic with no stepOrdinal (case-level error)", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "prereq_cycle",
      caseId: "a",
      message: "cycle a→b→a",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a code outside the catalog", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "kaboom",
      caseId: "a",
      message: "x",
    });
    expect(r.success).toBe(false);
  });
});

/**
 * The `src/index.ts` barrel re-exports `./schemas/index.js` (task A5). If a schema file
 * imports BACK UP to that barrel, the module graph becomes a cycle: load the barrel ⇒
 * load schemas ⇒ load the schema file ⇒ read the barrel's constant while the barrel's
 * body HASN'T run yet ⇒ `ReferenceError: Cannot access 'RUN_VERDICTS' before
 * initialization` under real ESM (tsx/node).
 *
 * Vitest does NOT catch this — vite-node's SSR transform orders things differently, so
 * it still stays green. So the rule must be enforced statically: a schema may only import
 * the LEAF module (`../enums.js`), never the barrel.
 */
describe("guards against an import cycle through the barrel", () => {
  const schemasDir = dirname(fileURLToPath(import.meta.url));

  it("no schema file imports back up to `../index.js`", () => {
    const offenders = readdirSync(schemasDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .filter((f) => /from\s+"\.\.\/index\.js"/.test(readFileSync(join(schemasDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("runSchema", () => {
  const run = {
    id: "run-001",
    teamId: "team-acme",
    projectId: "proj-web-checkout",
    lane: "batch",
    status: "succeeded",
    verdict: "passed",
    planContentHash: "a".repeat(64),
    diagnostics: [],
  };

  it("accepts a passed run", () => {
    expect(runSchema.parse(run).verdict).toBe("passed");
  });

  it("accepts a compile_error run with diagnostics and NO planContentHash", () => {
    const { planContentHash: _drop, ...noPlan } = run;
    const r = runSchema.safeParse({
      ...noPlan,
      status: "failed",
      verdict: "compile_error",
      diagnostics: [{ severity: "error", code: "unknown_verb", caseId: "a", message: "web.teleport" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a planContentHash that isn't 64-char sha256 hex", () => {
    expect(runSchema.safeParse({ ...run, planContentHash: "deadbeef" }).success).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(runSchema.safeParse({ ...run, verdict: "flaky" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(runSchema.safeParse({ ...run, status: "queued" }).success).toBe(false);
  });
});
