import { describe, expect, it } from "vitest";
import type { RevisionPayload, RevisionStep } from "./payload.js";
import { diffFlat, flattenRevision, threeWayDiff } from "./diff.js";

function step(id: string, after: string | null, sentence: string): RevisionStep {
  return {
    id,
    kind: "action",
    parentId: null,
    after,
    renderedSentence: sentence,
    verbOpKey: "click",
  };
}

const BASE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

/** Inserts s9 in the middle: only s2's `after` changes, no other step is touched. */
const MINE: RevisionPayload = {
  case: { name: "Checkout", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s9", "s1", "accept cookie banner"),
    step("s2", "s9", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click submit"),
  ],
};

const THEIRS: RevisionPayload = {
  case: { name: "Checkout v2", isStepGroup: false },
  steps: [
    step("s1", null, "open login page"),
    step("s2", "s1", "type username"),
    step("s3", "s2", "type password"),
    step("s4", "s3", "click the submit button"),
  ],
};

describe("flattenRevision", () => {
  it("collects the case's scalars and maps fields by step id", () => {
    const f = flattenRevision(BASE);
    expect(f.scalars.get("/name")).toBe('"Checkout"');
    expect(f.steps.size).toBe(4);
    expect(f.steps.get("s2")?.get("after")).toBe('"s1"');
    expect(f.steps.get("s1")?.get("after")).toBe("null");
  });

  it("does NOT put ordinal into the flat form — position only exists as `after`", () => {
    const f = flattenRevision(BASE);
    for (const fields of f.steps.values()) expect(fields.has("ordinal")).toBe(false);
  });
});

describe("diffFlat — zero noise when inserting a step", () => {
  it("inserting EXACTLY 1 step produces EXACTLY 2 entries (spike: third-party libraries produce 4)", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect(d).toEqual([
      { path: "/steps/s2/after", kind: "modified", base: "s1", value: "s9" },
      { path: "/steps/s9", kind: "added", value: MINE.steps[1] },
    ]);
  });

  it("editing the case name + one step's sentence produces exactly 2 entries", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(THEIRS));
    expect(d.map((c) => c.path)).toEqual(["/name", "/steps/s4/renderedSentence"]);
    expect(d.every((c) => c.kind === "modified")).toBe(true);
  });

  it("deleting a step reports removed at STEP LEVEL, not broken down field by field", () => {
    const shorter: RevisionPayload = {
      case: BASE.case,
      steps: [step("s1", null, "open login page"), step("s3", "s1", "type password"), step("s4", "s3", "click submit")],
    };
    const d = diffFlat(flattenRevision(BASE), flattenRevision(shorter));
    expect(d.filter((c) => c.kind === "removed").map((c) => c.path)).toEqual(["/steps/s2"]);
  });

  it("identical payloads ⇒ empty diff", () => {
    expect(diffFlat(flattenRevision(BASE), flattenRevision(BASE))).toEqual([]);
  });

  it("results are sorted by path — the 409 body is stable across two runs", () => {
    const d = diffFlat(flattenRevision(BASE), flattenRevision(MINE));
    expect([...d].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(d);
  });
});

describe("threeWayDiff", () => {
  const meta = { baseVersion: 7, baseRevisionId: "r7", currentVersion: 9, currentRevisionId: "r9" };

  it("both sides edit different spots ⇒ conflicts is empty", () => {
    const r = threeWayDiff({ base: BASE, mine: MINE, theirs: THEIRS, ...meta });
    expect(r.mine).toHaveLength(2);
    expect(r.theirs).toHaveLength(2);
    expect(r.conflicts).toEqual([]);
    expect(r.baseVersion).toBe(7);
    expect(r.currentRevisionId).toBe("r9");
  });

  it("both sides edit the SAME field ⇒ that path is in conflicts", () => {
    const mine2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const theirs2: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "press the submit control")],
    };
    const r = threeWayDiff({ base: BASE, mine: mine2, theirs: theirs2, ...meta });
    expect(r.conflicts).toEqual(["/steps/s4/renderedSentence"]);
  });

  it("both sides make an IDENTICAL edit ⇒ NOT a conflict (same end result)", () => {
    const same: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: same, theirs: same, ...meta });
    expect(r.conflicts).toEqual([]);
  });

  it("a delete on one side and an edit on the other for the SAME step ⇒ a step-level conflict", () => {
    const deleted: RevisionPayload = { case: BASE.case, steps: [...BASE.steps.slice(0, 3)] };
    const edited: RevisionPayload = {
      case: BASE.case,
      steps: [...BASE.steps.slice(0, 3), step("s4", "s3", "tap submit")],
    };
    const r = threeWayDiff({ base: BASE, mine: deleted, theirs: edited, ...meta });
    expect(r.conflicts).toContain("/steps/s4");
  });
});
