import { describe, expect, it } from "vitest";
import type { StepInputDto } from "@testkite/contract";
import { buildRevisionPayload, flattenStepInputs } from "./steps-flatten.js";

/** Sequentially generated ids so the test can compare byte-for-byte. */
function seqIds(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

const TREE: StepInputDto[] = [
  { id: "s1", kind: "action", renderedSentence: "open login", verbOpKey: "goto" },
  {
    kind: "if",
    renderedSentence: "if ok",
    conditionExpected: ["SUCCESS"],
    children: [
      { id: "s2", kind: "action", renderedSentence: "type username", verbOpKey: "type", args: { value: "qa" } },
      {
        kind: "for",
        renderedSentence: "for each row",
        loopDataProfileId: "d1",
        children: [{ kind: "rest", renderedSentence: "POST orders", method: "POST", url: "https://x.test/o" }],
      },
    ],
  },
];

describe("flattenStepInputs", () => {
  it("flattens the tree in pre-order, ordinal recounted within each sibling group", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: TREE,
      existingIds: new Set(["s1", "s2"]),
      newId: seqIds(),
    });
    expect(r.steps.map((s) => [s.id, s.parentStepId, s.ordinal, s.kind])).toEqual([
      ["s1", null, 1, "action"],
      ["new-1", null, 2, "if"],
      ["s2", "new-1", 1, "action"],
      ["new-2", "new-1", 2, "for"],
      ["new-3", "new-2", 1, "rest"],
    ]);
  });

  it("KEEPS the client-sent id when it already belongs to the case; issues a new id when the id is unknown", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: [{ id: "not-in-this-case", kind: "action", renderedSentence: "x", verbOpKey: "click" }],
      existingIds: new Set(["s1"]),
      newId: seqIds(),
    });
    expect(r.steps[0]?.id).toBe("new-1");
  });

  it("splits loop details into LoopRow, REST details into RestRow", () => {
    const r = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(["s1", "s2"]), newId: seqIds() });
    expect(r.loops).toEqual([{ stepId: "new-2", dataProfileId: "d1", maxIterations: null }]);
    expect(r.rests).toEqual([
      { stepId: "new-3", method: "POST", url: "https://x.test/o", headers: null, body: null, storeAs: null },
    ]);
  });

  it("columns for other kinds are always NULL — matches CHECK aut_steps_kind_shape", () => {
    const r = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(), newId: seqIds() });
    const ifRow = r.steps.find((s) => s.kind === "if");
    expect(ifRow?.verbOpKey).toBeNull();
    expect(ifRow?.stepGroupCaseId).toBeNull();
    expect(ifRow?.conditionExpected).toEqual(["SUCCESS"]);
    const forRow = r.steps.find((s) => s.kind === "for");
    expect(forRow?.verbOpKey).toBeNull();
    expect(forRow?.conditionExpected).toBeNull();
  });

  it("while without maxIterations still flattens fine — the compiler is the one that judges it", () => {
    const r = flattenStepInputs({
      caseId: "c1",
      steps: [{ kind: "while", renderedSentence: "while spinner", children: [] }],
      existingIds: new Set(),
      newId: seqIds(),
    });
    expect(r.loops).toEqual([{ stepId: "new-1", dataProfileId: null, maxIterations: null }]);
  });
});

describe("buildRevisionPayload", () => {
  it("encodes position via `after` (the preceding sibling's id), with NO ordinal", () => {
    const flat = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(["s1", "s2"]), newId: seqIds() });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    expect(payload.steps.map((s) => [s.id, s.parentId, s.after])).toEqual([
      ["s1", null, null],
      ["new-1", null, "s1"],
      ["s2", "new-1", null],
      ["new-2", "new-1", "s2"],
      ["new-3", "new-2", null],
    ]);
    expect(JSON.stringify(payload)).not.toContain("ordinal");
  });

  it("attaches loop/rest to the correct step", () => {
    const flat = flattenStepInputs({ caseId: "c1", steps: TREE, existingIds: new Set(), newId: seqIds() });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    const forStep = payload.steps.find((s) => s.kind === "for");
    expect(forStep?.loop).toEqual({ dataProfileId: "d1" });
    const restStep = payload.steps.find((s) => s.kind === "rest");
    expect(restStep?.rest).toEqual({ method: "POST", url: "https://x.test/o" });
  });

  it("omits undefined fields entirely — the canonical hash must not depend on how the object was built", () => {
    const flat = flattenStepInputs({
      caseId: "c1",
      steps: [{ kind: "action", renderedSentence: "click", verbOpKey: "click" }],
      existingIds: new Set(),
      newId: seqIds(),
    });
    const payload = buildRevisionPayload({
      case: { name: "C", isStepGroup: false },
      steps: flat.steps,
      loops: flat.loops,
      rests: flat.rests,
    });
    expect(Object.keys(payload.steps[0] ?? {}).sort()).toEqual([
      "after", "id", "kind", "parentId", "renderedSentence", "verbOpKey",
    ]);
  });
});
