import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFixture } from "./fixture.js";
import type { CompileFixture } from "./fixture.js";
import { canonicalJson, compileRun, COMPILE_ERROR_CODES } from "./index.js";
import type { CompileErrorCode, CompileOutput } from "./index.js";
import type { AuthoredStep, CompileSnapshot, StepKind } from "./snapshot.js";

/**
 * T1 — GOLDEN SUITE: the whole system's contract (blueprint §4, "8-layer Testing").
 *
 * The compiler is the point everything else trusts: the worker runs exactly this plan, the
 * dispatcher computes cost from this plan's `stepCount`, results are attributed to this
 * plan's `contentHash`. An accidental change in the compiler therefore doesn't break "a
 * test" — it changes the MEANING of already-stored data. A golden file is an audited
 * snapshot of that meaning: it can change, but only DELIBERATELY, and the diff must sit in
 * a PR for someone else to read.
 *
 * How to run:
 *   pnpm -F @testkite/run-compiler test:golden                  # compare (CI, default)
 *   UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden  # rewrite golden, then READ THE DIFF
 *
 * `node:fs` here does NOT break the "compiler is PURE" rule: this file is a test, reading
 * fixtures from disk; no production module in the package imports it (the plan-generation
 * path is still pure computation).
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const UPDATE_GOLDEN = process.env["UPDATE_GOLDEN"] === "1";
const UPDATE_HINT = "run: UPDATE_GOLDEN=1 pnpm -F @testkite/run-compiler test:golden";

interface LoadedFixture {
  readonly fixture: CompileFixture;
  readonly file: string;
  readonly goldenFile: string;
}

const FIXTURES = loadFixtures();

function loadFixtures(): readonly LoadedFixture[] {
  if (!existsSync(FIXTURES_DIR)) {
    throw new Error(`Fixtures directory not found: ${FIXTURES_DIR}`);
  }

  const files = readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".golden.json"))
    .sort(byCodeUnit);

  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    return { fixture: parseFixture(raw, file), file, goldenFile: goldenNameOf(file) };
  });
}

function goldenNameOf(file: string): string {
  return `${file.slice(0, -".json".length)}.golden.json`;
}

// ---------------------------------------------------------------------------
// The fixture SET's contract (not each individual fixture's)
// ---------------------------------------------------------------------------

describe("golden fixture set", () => {
  it("has at least 20 fixtures", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("a fixture's name matches its file name, and no two are the same", () => {
    for (const { fixture, file } of FIXTURES) {
      expect(`${fixture.name}.json`).toBe(file);
    }
    expect(new Set(FIXTURES.map((f) => f.fixture.name)).size).toBe(FIXTURES.length);
  });

  it("EVERY CompileErrorCode has at least 1 negative fixture (rule §4: no code goes unproven)", () => {
    const covered = new Set<CompileErrorCode>();
    for (const { fixture } of FIXTURES) for (const code of fixture.expectCodes) covered.add(code);

    const missing = COMPILE_ERROR_CODES.filter((code) => !covered.has(code));
    expect(missing).toEqual([]);
  });

  it("EVERY construct has at least 1 positive fixture", () => {
    const positives = FIXTURES.filter((f) => f.fixture.expect === "plan").map(
      (f) => f.fixture.input.snapshot,
    );

    const kinds = new Set<StepKind>();
    for (const snapshot of positives) {
      for (const kase of Object.values(snapshot.cases)) {
        walkSteps(kase.steps, (step) => kinds.add(step.kind));
      }
    }
    const missingKinds = (["action", "step_group", "if", "for", "while", "rest"] as const).filter(
      (kind) => !kinds.has(kind),
    );
    expect(missingKinds).toEqual([]);

    const hasPrereqChain = positives.some((s) =>
      Object.values(s.cases).some((c) => c.prereqCaseId !== undefined),
    );
    const hasDeepChain = positives.some((s) => longestChain(s) === 5);
    const hasDataDriven = positives.some((s) =>
      Object.values(s.cases).some((c) => c.dataProfileId !== undefined),
    );
    const hasSecretRef = positives.some((s) => secretRefsOf(s).length > 0);
    const hasKitchenSink = FIXTURES.some((f) => f.fixture.name.includes("kitchen-sink"));

    expect({ hasPrereqChain, hasDeepChain, hasDataDriven, hasSecretRef, hasKitchenSink }).toEqual({
      hasPrereqChain: true,
      hasDeepChain: true,
      hasDataDriven: true,
      hasSecretRef: true,
      hasKitchenSink: true,
    });
  });

  it("has no orphaned golden (deleting a fixture must delete its golden with it)", () => {
    const expected = new Set(FIXTURES.map((f) => f.goldenFile));
    const orphans = readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith(".golden.json"))
      .filter((file) => !expected.has(file));

    expect(orphans).toEqual([]);
  });

  it("UPDATE_GOLDEN must never be on in CI (otherwise golden rewrites itself)", () => {
    expect(UPDATE_GOLDEN && process.env["CI"] !== undefined).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EACH fixture's own contract
// ---------------------------------------------------------------------------

describe("golden", () => {
  for (const loaded of FIXTURES) {
    const { fixture, goldenFile } = loaded;

    it(`${fixture.name} — ${fixture.description}`, () => {
      const output = compileRun(fixture.input);

      assertExpectationHolds(fixture, output);
      assertDeterministic(fixture, output);
      assertSecretsStayRefs(fixture, output);
      assertMatchesGolden(goldenFile, output);
    });
  }
});

/** A fixture declares itself positive/negative; the runner checks that claim against reality BEFORE comparing golden. */
function assertExpectationHolds(fixture: CompileFixture, output: CompileOutput): void {
  const errorCodes = output.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.code);

  if (fixture.expect === "plan") {
    expect(errorCodes).toEqual([]);
    expect(output.plan).toBeDefined();
    return;
  }

  expect(output.plan).toBeUndefined();
  expect(uniqueSorted(errorCodes)).toEqual(uniqueSorted(fixture.expectCodes));
}

/**
 * The whole system's foundational rule: same input ⇒ same plan, same hash, forever.
 * Recompiling RIGHT HERE in the test is the cheapest way to catch a `Date.now()`/
 * `Math.random()`/Map ordering bug that slipped into the plan-generation path.
 */
function assertDeterministic(fixture: CompileFixture, output: CompileOutput): void {
  const again = compileRun(fixture.input);
  expect(canonicalJson(again)).toBe(canonicalJson(output));
  expect(again.plan?.contentHash).toBe(output.plan?.contentHash);
}

/**
 * A secret is NEVER inlined: the plan is an immutable payload that gets hashed, stored,
 * and sent to the worker — a secret value landing in there is exposed forever. Every
 * `$secret:X` from the snapshot must still be VERBATIM in the plan.
 */
function assertSecretsStayRefs(fixture: CompileFixture, output: CompileOutput): void {
  const { plan } = output;
  if (plan === undefined) return;

  const planJson = canonicalJson(plan);
  for (const ref of secretRefsOf(fixture.input.snapshot)) {
    expect(planJson).toContain(JSON.stringify(ref));
  }
}

function assertMatchesGolden(goldenFile: string, output: CompileOutput): void {
  const goldenPath = join(FIXTURES_DIR, goldenFile);
  const text = goldenTextOf(output);

  if (UPDATE_GOLDEN) {
    writeFileSync(goldenPath, text, "utf8");
    return;
  }

  if (!existsSync(goldenPath)) {
    throw new Error(`Missing golden "${goldenFile}" — ${UPDATE_HINT}`);
  }

  expect(text).toBe(readFileSync(goldenPath, "utf8"));
}

/**
 * Golden = CompileOutput in its CANONICAL form (keys sorted recursively — the exact order
 * fed into SHA-256), printed with 2-space indent so a PR diff is readable by eye. `plan` is
 * absent for a negative fixture, exactly per the contract "≥1 error ⇒ no plan produced".
 */
function goldenTextOf(output: CompileOutput): string {
  const canonical: unknown = JSON.parse(canonicalJson(output));
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function walkSteps(steps: readonly AuthoredStep[], visit: (step: AuthoredStep) => void): void {
  for (const step of steps) {
    visit(step);
    if (step.children !== undefined) walkSteps(step.children, visit);
  }
}

/** The ANCESTOR count of the longest prereq chain in the snapshot (capped at 50 so a cycle fixture doesn't hang). */
function longestChain(snapshot: CompileSnapshot): number {
  let longest = 0;

  for (const targetId of snapshot.targetCaseIds) {
    let ancestors = 0;
    let currentId = snapshot.cases[targetId]?.prereqCaseId;
    while (currentId !== undefined && ancestors < 50) {
      ancestors += 1;
      currentId = snapshot.cases[currentId]?.prereqCaseId;
    }
    longest = Math.max(longest, ancestors);
  }

  return longest;
}

function secretRefsOf(snapshot: CompileSnapshot): readonly string[] {
  const refs = new Set<string>();

  for (const kase of Object.values(snapshot.cases)) {
    walkSteps(kase.steps, (step) => {
      for (const value of Object.values(step.args ?? {})) {
        if (value.startsWith("$secret:")) refs.add(value);
      }
    });
  }

  return [...refs].sort(byCodeUnit);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(byCodeUnit);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
