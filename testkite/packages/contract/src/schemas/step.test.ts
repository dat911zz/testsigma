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
  it("nhận action đủ trường", () => {
    expect(authoredStepSchema.parse(action)).toMatchObject({ kind: "action", verbOpKey: "web.click" });
  });

  it("nhận action không elementId (verb không cần element)", () => {
    const { elementId: _drop, ...noElement } = action;
    expect(authoredStepSchema.safeParse(noElement).success).toBe(true);
  });

  it("từ chối action thiếu verbOpKey", () => {
    const { verbOpKey: _drop, ...noVerb } = action;
    expect(authoredStepSchema.safeParse(noVerb).success).toBe(false);
  });

  it("từ chối ordinal 0 — ordinal đếm từ 1 như fixture", () => {
    expect(authoredStepSchema.safeParse({ ...action, ordinal: 0 }).success).toBe(false);
  });

  it("từ chối args có value không phải chuỗi — secret giữ dạng $secret:NAME, luôn là chuỗi", () => {
    expect(authoredStepSchema.safeParse({ ...action, args: { timeout: 30 } }).success).toBe(false);
  });
});

describe("authoredStepSchema — block", () => {
  it("nhận if lồng action trong children", () => {
    const parsed = authoredStepSchema.parse({
      kind: "if",
      ordinal: 1,
      renderedSentence: "If login succeeded",
      conditionExpected: ["SUCCESS"],
      children: [{ ...action, ordinal: 1 }],
    });
    expect(parsed).toMatchObject({ kind: "if" });
  });

  it("nhận if lồng if (đệ quy 2 tầng)", () => {
    const inner = { kind: "if", ordinal: 1, renderedSentence: "inner", conditionExpected: ["SUCCESS"], children: [action] };
    const outer = { kind: "if", ordinal: 1, renderedSentence: "outer", conditionExpected: ["SUCCESS"], children: [inner] };
    expect(authoredStepSchema.safeParse(outer).success).toBe(true);
  });

  it("từ chối if không conditionExpected", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "if", ordinal: 1, renderedSentence: "x", children: [] }).success,
    ).toBe(false);
  });

  it("NHẬN while thiếu maxIterations — trần lặp là phán quyết của compiler, không phải của biên API", () => {
    // `while` không trần vẫn là dữ liệu authoring HỢP LỆ: compiler bắt nó và phát
    // `while_without_max_iterations` (fixture err-while-without-max-iterations.json).
    // Chặn ở đây bằng 400 là cướp mất lô diagnostic gom-một-lượt mà tác giả cần
    // (err-gather-all-not-first-fail.json đòi 8 code trong CÙNG một lần compile).
    expect(
      authoredStepSchema.safeParse({ kind: "while", ordinal: 1, renderedSentence: "x", children: [action] }).success,
    ).toBe(true);
  });

  it("nhận while có maxIterations", () => {
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

  it("nhận for có loopDataProfileId", () => {
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

  it("nhận step_group có stepGroupCaseId", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "step_group",
        ordinal: 1,
        renderedSentence: "Run group login",
        stepGroupCaseId: "grp-login",
      }).success,
    ).toBe(true);
  });

  it("nhận rest", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "rest", ordinal: 1, renderedSentence: "GET /health", args: {} }).success,
    ).toBe(true);
  });

  it("từ chối kind lạ", () => {
    expect(authoredStepSchema.safeParse({ ...action, kind: "goto" }).success).toBe(false);
  });
});
