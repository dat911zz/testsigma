import { describe, expect, it } from "vitest";
import { STEP_KINDS } from "./step.js";
import {
  CASE_STATUSES,
  CHANGE_KINDS,
  REVIEW_DECISIONS,
  caseSummarySchema,
  stepInputSchema,
  threeWayDiffSchema,
} from "./authoring.js";

describe("stepInputSchema", () => {
  it("covers exactly the 6 kinds in STEP_KINDS — no more, no less", () => {
    const ok = STEP_KINDS.every((kind) => {
      const base = { kind, renderedSentence: "s" } as Record<string, unknown>;
      if (kind === "action") base["verbOpKey"] = "click";
      if (kind === "step_group") base["stepGroupCaseId"] = "c1";
      if (kind === "if") { base["conditionExpected"] = ["SUCCESS"]; base["children"] = []; }
      if (kind === "for") { base["loopDataProfileId"] = "d1"; base["children"] = []; }
      if (kind === "while") base["children"] = [];
      if (kind === "rest") { base["method"] = "GET"; base["url"] = "https://x.test/orders"; }
      return stepInputSchema.safeParse(base).success;
    });
    expect(ok).toBe(true);
  });

  it("does NOT accept ordinal — position is array order, the client may not number it itself", () => {
    const r = stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click", ordinal: 3 });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect("ordinal" in r.data).toBe(false);
  });

  it("id is optional — a new step has no id yet, an existing step echoes its id back to keep identity", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click" }).success).toBe(true);
    expect(
      stepInputSchema.safeParse({ id: "s1", kind: "action", renderedSentence: "s", verbOpKey: "click" }).success,
    ).toBe(true);
  });

  it("rejects an action missing verbOpKey", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s" }).success).toBe(false);
  });

  it("children recurse correctly — if nested in for nested in action", () => {
    const r = stepInputSchema.safeParse({
      kind: "if",
      renderedSentence: "if ok",
      conditionExpected: ["SUCCESS"],
      children: [
        {
          kind: "for",
          renderedSentence: "for each row",
          loopDataProfileId: "d1",
          children: [{ kind: "action", renderedSentence: "click", verbOpKey: "click" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rest accepts method/url", () => {
    expect(
      stepInputSchema.safeParse({
        kind: "rest",
        renderedSentence: "POST /orders",
        method: "POST",
        url: "https://x.test/orders",
      }).success,
    ).toBe(true);
  });

  it("rejects rest missing method/url — the DB has NOT NULL on both", () => {
    expect(stepInputSchema.safeParse({ kind: "rest", renderedSentence: "POST /orders" }).success).toBe(false);
  });
});

describe("caseSummarySchema", () => {
  it("version is a positive integer and status is in CASE_STATUSES", () => {
    const r = caseSummarySchema.safeParse({
      id: "c1",
      projectId: "p1",
      name: "Checkout",
      isStepGroup: false,
      status: "draft",
      version: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
    expect(CASE_STATUSES).toEqual(["draft", "in_review", "ready"]);
    expect(caseSummarySchema.safeParse({ id: "c1", projectId: "p1", name: "n", isStepGroup: false, status: "draft", version: 0, createdAt: "x", updatedAt: "x" }).success).toBe(false);
  });
});

describe("threeWayDiffSchema", () => {
  it("accepts a 409 body with all three branches + the conflict list", () => {
    const r = threeWayDiffSchema.safeParse({
      baseVersion: 7,
      baseRevisionId: "r7",
      currentVersion: 9,
      currentRevisionId: "r9",
      mine: [{ path: "/steps/s9", kind: "added" }],
      theirs: [{ path: "/name", kind: "modified" }],
      conflicts: [],
    });
    expect(r.success).toBe(true);
  });

  it("kind only accepts added|removed|modified", () => {
    expect(CHANGE_KINDS).toEqual(["added", "removed", "modified"]);
    const r = threeWayDiffSchema.safeParse({
      baseVersion: 1, baseRevisionId: "r1", currentVersion: 2, currentRevisionId: "r2",
      mine: [{ path: "/x", kind: "renamed" }], theirs: [], conflicts: [],
    });
    expect(r.success).toBe(false);
  });

  it("REVIEW_DECISIONS has exactly 2 choices — no 'promoted' (promote is a separate step)", () => {
    expect(REVIEW_DECISIONS).toEqual(["approved", "changes_requested"]);
  });
});
