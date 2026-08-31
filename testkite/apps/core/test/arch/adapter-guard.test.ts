/**
 * A guard nobody has watched fail is not a guard. `tools/lint-rules.test.ts` proves the ESLint
 * rules by running ESLint over deliberately broken fixtures; this file does the same for a rule
 * TypeScript enforces, by running the compiler itself over the fixtures in
 * `../typecheck-fixtures/`.
 *
 * The POSITIVE fixture is the load-bearing half. A misconfigured program reports errors on
 * everything, and then the three negative cases below would pass while proving nothing; so the
 * complete map must come out with ZERO semantic diagnostics.
 *
 * The error codes are measured, not guessed (2026-08-31, tsc 5.7.3): `satisfies` reports a
 * missing property as TS1360, NOT TS2739.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { STEP_RESULT_FIELDS } from "../../src/http/internal/routes.js";
import { ADAPTER_FIELD_MAPS } from "../../src/modules/orchestration/run-service.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "typecheck-fixtures");

/**
 * The repo's real strictness, restated here rather than read from `tsconfig.json`: the fixtures
 * live OUTSIDE that project's `include`, and the two settings that decide whether an optional
 * field is a distinct thing at all — `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
 * — are exactly what this guard is about. Reading them from disk would let a config edit quietly
 * weaken the proof.
 */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  noEmit: true,
};

interface Diagnosis {
  readonly code: number;
  readonly text: string;
}

function diagnose(fixture: string): readonly Diagnosis[] {
  const file = join(FIXTURES, fixture);
  const program = ts.createProgram([file], OPTIONS);
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`fixture not resolved: ${fixture}`);
  return program
    .getSemanticDiagnostics(source)
    .map((d) => ({ code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, " ") }));
}

describe("FieldMap guard (tier 1)", () => {
  it("NEGATIVE CONTROL: a complete map, and a deliberate null drop, compile clean", () => {
    expect(diagnose("field-map-complete.ts")).toEqual([]);
  });

  it("CATCHES a DTO field the map does not mention, and names it", () => {
    const d = diagnose("field-map-missing-field.ts");
    expect(d.map((x) => x.code)).toContain(1360);
    expect(d.map((x) => x.text).join(" ")).toContain("ownerId");
  });

  it("CATCHES a destination key that does not exist on the domain type", () => {
    expect(diagnose("field-map-bad-destination.ts").map((x) => x.code)).toContain(2322);
  });

  it("CATCHES a map key that is not a DTO field", () => {
    expect(diagnose("field-map-unknown-key.ts").map((x) => x.code)).toContain(2353);
  });

  it("CATCHES it on the REAL contract DTO, not just a toy pair", () => {
    const d = diagnose("adapter-authored-case-next.ts");
    expect(d.map((x) => x.code)).toContain(1360);
    expect(d.map((x) => x.text).join(" ")).toContain("ownerId");
  });

  it("CATCHES it on the CompletedStep DTO that BOTH fleet-boundary tables share", () => {
    const d = diagnose("adapter-completed-step-next.ts");
    expect(d.map((x) => x.code)).toContain(1360);
    expect(d.map((x) => x.text).join(" ")).toContain("retriedFrom");
  });
});

/**
 * TIER 2, apps/core's half. The type guard proves every DTO field was LOOKED AT; it cannot prove
 * the function body copies it, so the only way to say "looked at, not carried" — a `null` entry —
 * is pinned here. Dropping a field then costs two visible decisions instead of one slip.
 *
 * BOTH of core's tables are walked. The runner's table is pinned by its OWN test
 * (apps/runner/test/arch/field-map-drops.test.ts) because the two apps are peers with no
 * dependency between them — this file cannot even resolve apps/runner/src/worker.ts.
 * tools/field-map-inventory.test.ts is what keeps the two halves from drifting apart.
 */
const CORE_FIELD_MAPS = {
  runService: ADAPTER_FIELD_MAPS,
  internalRoutes: { stepResult: STEP_RESULT_FIELDS },
} as const;

/** Every `null` entry, as a dotted path, sorted. `null` is the only shape a drop can take. */
function drops(maps: Readonly<Record<string, unknown>>): readonly string[] {
  const found: string[] = [];
  const walk = (prefix: string, node: Readonly<Record<string, unknown>>): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (value === null) found.push(path);
      else if (typeof value === "object") walk(path, value as Record<string, unknown>);
    }
  };
  walk("", maps);
  return found.sort();
}

describe("core field maps (tier 2)", () => {
  it("drops exactly the fields this list names, and nothing else", () => {
    expect(drops(CORE_FIELD_MAPS)).toEqual([
      // Consumed by the grouping in `toCaseResults` (one res_case_results row per caseId), so it
      // is deliberately absent from the step row, where it would repeat on every step.
      "internalRoutes.stepResult.caseId",
    ]);
  });
});
