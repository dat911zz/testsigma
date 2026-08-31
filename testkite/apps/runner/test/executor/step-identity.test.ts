/**
 * The executor is the ONLY place that knows how many times a step body actually ran, so it is
 * the only place that can name an execution. These tests pin the three claims the rest of the
 * chain is built on: the number is dense and in emission order, the loop position is reported
 * outermost-first, and two steps that share an ordinal (an inlined step group repeats the
 * group's own ordinals) stay apart.
 *
 * Like every file under executor/, this runs on `FakeBrowserEngine`: what is proved here is the
 * NUMBERING, never anything about a browser.
 */
import type { CasePlan, ChainPlan, DataRow, RunPolicy, StepPlan } from "@testkite/run-compiler";
import type { VerbDefinition } from "@testkite/verb-kit";
import { describe, expect, it } from "vitest";
import { FakeBrowserEngine } from "../../src/browser/fake-engine.js";
import { runChain, type RunChainDeps, type StepOutcome } from "../../src/executor/run-chain.js";

const policy: RunPolicy = {
  lane: "batch",
  engine: "chromium-headless-shell",
  retry: "infra-only",
  screenshots: "failure",
  baseUrl: "https://staging.example.test",
};

function action(ordinal: number, renderedSentence = `Click on button ${String(ordinal)}`): StepPlan {
  return { kind: "action", ordinal, renderedSentence, groupPath: [], args: { element: "btn" }, opKey: "web.click" };
}

function row(label: string): DataRow {
  return { label, expectedToFail: false, values: { user: label } };
}

function rows(count: number): readonly DataRow[] {
  return Array.from({ length: count }, (_v, i) => row(`row-${String(i + 1)}`));
}

function forBlock(ordinal: number, loopRows: readonly DataRow[], children: readonly StepPlan[]): StepPlan {
  return { kind: "for", ordinal, renderedSentence: "For each row", groupPath: [], args: {}, children, loopRows };
}

function caseOf(caseId: string, steps: readonly StepPlan[]): CasePlan {
  return { caseId, revisionId: "rev-1", expectedToFail: false, steps };
}

function chainOf(cases: readonly CasePlan[]): ChainPlan {
  const stepCount = cases.reduce((total, k) => total + k.steps.length, 0);
  return { chainKey: "login>checkout", cases, stepCount, timeoutSeconds: 180 };
}

function verb(execute: VerbDefinition["execute"]): VerbDefinition {
  return { opKey: "web.click", sentence: "Click on {element}", params: [], needsRendering: true, execute };
}

function deps(execute: VerbDefinition["execute"] = async () => ({ ok: true })): RunChainDeps {
  return {
    engine: new FakeBrowserEngine(),
    resolveVerb: () => verb(execute),
    now: () => Date.now(),
    onStep: () => {},
    screenshot: async () => null,
    log: () => {},
  };
}

/** Outer 2 rows, inner 3 rows, one action inside the inner body => 6 executions. */
const nested2x3 = chainOf([
  caseOf("c1", [forBlock(1, rows(2), [forBlock(2, rows(3), [action(3)])])]),
]);

describe("step execution identity", () => {
  it("numbers every executed step densely, in emission order, across the whole chain", async () => {
    const outcome = await runChain(
      chainOf([caseOf("c1", [action(1), action(2)]), caseOf("c2", [action(1)])]),
      policy,
      deps(),
    );
    expect(outcome.steps.map((s) => s.execSeq)).toEqual([1, 2, 3]);
    expect(outcome.steps.map((s) => s.caseId)).toEqual(["c1", "c1", "c2"]);
  });

  it("gives a 3-row `for` three distinct executions of the same ordinal", async () => {
    const outcome = await runChain(chainOf([caseOf("c1", [forBlock(1, rows(3), [action(2)])])]), policy, deps());
    expect(outcome.steps).toHaveLength(3);
    expect(outcome.steps.map((s) => s.ordinal)).toEqual([2, 2, 2]);
    expect(outcome.steps.map((s) => s.execSeq)).toEqual([1, 2, 3]);
    expect(outcome.steps.map((s) => s.loopPath)).toEqual([[1], [2], [3]]);
  });

  it("reports a nested loop outermost-first", async () => {
    const outcome = await runChain(nested2x3, policy, deps());
    expect(outcome.steps.map((s) => s.loopPath)).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
    expect(outcome.steps.map((s) => s.execSeq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps two steps that share an ordinal apart, with NO loop in sight", async () => {
    // The shape of packages/run-compiler/fixtures/group-inline-flat.golden.json: an inlined step
    // group repeats its own ordinals, so a case's flat step list really is 1, 2, 3, 2.
    const outcome = await runChain(
      chainOf([caseOf("c1", [action(1), action(2), action(3), action(2)])]),
      policy,
      deps(),
    );
    expect(outcome.steps.map((s) => s.ordinal)).toEqual([1, 2, 3, 2]);
    expect(new Set(outcome.steps.map((s) => s.execSeq)).size).toBe(4);
    for (const s of outcome.steps) expect(s.loopPath).toEqual([]);
  });

  it("carries the plan's rendered sentence, so nothing has to join it back by ordinal", async () => {
    const outcome = await runChain(
      chainOf([caseOf("c1", [action(1, "Click Login"), action(1, "Click Logout")])]),
      policy,
      deps(),
    );
    expect(outcome.steps.map((s) => s.renderedSentence)).toEqual(["Click Login", "Click Logout"]);
  });

  it("keeps execSeq equal to the outcome's own position in the reported array", async () => {
    // This is the invariant the control plane's backward-compatible reconstruction leans on:
    // a worker that sends no execSeq is reconstructed as index+1, and that must be the SAME number.
    const outcome = await runChain(nested2x3, policy, deps());
    outcome.steps.forEach((s: StepOutcome, i: number) => {
      expect(s.execSeq).toBe(i + 1);
    });
  });

  it("still records the steps that ran before a failing step, with their identity intact", async () => {
    let calls = 0;
    const outcome = await runChain(
      chainOf([caseOf("c1", [forBlock(1, rows(3), [action(2)])])]),
      policy,
      deps(async () => {
        calls += 1;
        return calls < 2 ? { ok: true } : { ok: false, failureMessage: "row 2 broke" };
      }),
    );
    expect(outcome.verdict).toBe("failed");
    expect(outcome.steps.map((s) => [s.execSeq, s.loopPath])).toEqual([
      [1, [1]],
      [2, [2]],
    ]);
  });

  it("hands the same identity to onStep as it puts in the reported array", async () => {
    // The live gallery is painted from `onStep` and the report from the array: two surfaces that
    // must narrate ONE execution, not two numbering schemes.
    const seen: StepOutcome[] = [];
    const outcome = await runChain(chainOf([caseOf("c1", [forBlock(1, rows(2), [action(2)])])]), policy, {
      ...deps(),
      onStep: (step) => seen.push(step),
    });
    expect(seen.map((s) => [s.execSeq, s.loopPath])).toEqual(outcome.steps.map((s) => [s.execSeq, s.loopPath]));
  });
});
