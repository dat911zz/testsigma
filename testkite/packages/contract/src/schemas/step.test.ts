import { describe, expect, it } from "vitest";
import { authoredStepSchema } from "./step.js";

const action = {
  kind: "action" as const,
  ordinal: 1,
  renderedSentence: "Click on el-signin",
  verbOpKey: "web.click",
  args: {},
  elementId: "el-signin",
};

describe("authoredStepSchema — action", () => {
  it("accepts an action with all fields", () => {
    expect(authoredStepSchema.parse(action)).toMatchObject({ kind: "action", verbOpKey: "web.click" });
  });

  it("accepts an action with no elementId (the verb doesn't need an element)", () => {
    const { elementId: _drop, ...noElement } = action;
    expect(authoredStepSchema.safeParse(noElement).success).toBe(true);
  });

  it("rejects an action missing verbOpKey", () => {
    const { verbOpKey: _drop, ...noVerb } = action;
    expect(authoredStepSchema.safeParse(noVerb).success).toBe(false);
  });

  it("rejects ordinal 0 — ordinal counts from 1, matching fixtures", () => {
    expect(authoredStepSchema.safeParse({ ...action, ordinal: 0 }).success).toBe(false);
  });

  it("rejects args with a non-string value — a secret stays $secret:NAME, always a string", () => {
    expect(authoredStepSchema.safeParse({ ...action, args: { timeout: 30 } }).success).toBe(false);
  });
});

describe("authoredStepSchema — block", () => {
  it("accepts an if with an action nested in children", () => {
    const parsed = authoredStepSchema.parse({
      kind: "if",
      ordinal: 1,
      renderedSentence: "If login succeeded",
      conditionExpected: ["SUCCESS"],
      children: [{ ...action, ordinal: 1 }],
    });
    expect(parsed).toMatchObject({ kind: "if" });
  });

  it("accepts an if nested inside an if (2-level recursion)", () => {
    const inner = { kind: "if", ordinal: 1, renderedSentence: "inner", conditionExpected: ["SUCCESS"], children: [action] };
    const outer = { kind: "if", ordinal: 1, renderedSentence: "outer", conditionExpected: ["SUCCESS"], children: [inner] };
    expect(authoredStepSchema.safeParse(outer).success).toBe(true);
  });

  it("rejects an if with no conditionExpected", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "if", ordinal: 1, renderedSentence: "x", children: [] }).success,
    ).toBe(false);
  });

  it("ACCEPTS a while missing maxIterations — the iteration cap is the compiler's call, not the API boundary's", () => {
    // A `while` with no cap is still VALID authoring data: the compiler catches it and
    // emits `while_without_max_iterations` (fixture err-while-without-max-iterations.json).
    // Blocking it here with a 400 would rob the author of the batched-in-one-pass
    // diagnostics they need (err-gather-all-not-first-fail.json requires 8 codes in the
    // SAME compile pass).
    expect(
      authoredStepSchema.safeParse({ kind: "while", ordinal: 1, renderedSentence: "x", children: [action] }).success,
    ).toBe(true);
  });

  it("accepts a while with maxIterations", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "while",
        ordinal: 1,
        renderedSentence: "x",
        maxIterations: 5,
        children: [action],
      }).success,
    ).toBe(true);
  });

  it("accepts a for with loopDataProfileId", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "for",
        ordinal: 1,
        renderedSentence: "x",
        loopDataProfileId: "p-logins",
        children: [action],
      }).success,
    ).toBe(true);
  });

  it("accepts a step_group with stepGroupCaseId", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "step_group",
        ordinal: 1,
        renderedSentence: "Run group login",
        stepGroupCaseId: "grp-login",
      }).success,
    ).toBe(true);
  });

  it("accepts rest", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "rest", ordinal: 1, renderedSentence: "GET /health", args: {} }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(authoredStepSchema.safeParse({ ...action, kind: "goto" }).success).toBe(false);
  });
});
