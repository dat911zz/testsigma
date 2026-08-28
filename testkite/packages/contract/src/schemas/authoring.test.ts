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
  it("phủ đúng 6 kind của STEP_KINDS — không thừa, không thiếu", () => {
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

  it("KHÔNG nhận ordinal — vị trí là thứ tự mảng, client không được tự đánh số", () => {
    const r = stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click", ordinal: 3 });
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect("ordinal" in r.data).toBe(false);
  });

  it("id là optional — step mới chưa có id, step cũ echo id về để giữ danh tính", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s", verbOpKey: "click" }).success).toBe(true);
    expect(
      stepInputSchema.safeParse({ id: "s1", kind: "action", renderedSentence: "s", verbOpKey: "click" }).success,
    ).toBe(true);
  });

  it("từ chối action thiếu verbOpKey", () => {
    expect(stepInputSchema.safeParse({ kind: "action", renderedSentence: "s" }).success).toBe(false);
  });

  it("children đệ quy đúng — if lồng for lồng action", () => {
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

  it("rest nhận method/url", () => {
    expect(
      stepInputSchema.safeParse({
        kind: "rest",
        renderedSentence: "POST /orders",
        method: "POST",
        url: "https://x.test/orders",
      }).success,
    ).toBe(true);
  });

  it("từ chối rest thiếu method/url — DB có NOT NULL trên cả hai", () => {
    expect(stepInputSchema.safeParse({ kind: "rest", renderedSentence: "POST /orders" }).success).toBe(false);
  });
});

describe("caseSummarySchema", () => {
  it("version là số nguyên dương và status thuộc CASE_STATUSES", () => {
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
  it("nhận body 409 đầy đủ ba nhánh + danh sách conflict", () => {
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

  it("kind chỉ nhận added|removed|modified", () => {
    expect(CHANGE_KINDS).toEqual(["added", "removed", "modified"]);
    const r = threeWayDiffSchema.safeParse({
      baseVersion: 1, baseRevisionId: "r1", currentVersion: 2, currentRevisionId: "r2",
      mine: [{ path: "/x", kind: "renamed" }], theirs: [], conflicts: [],
    });
    expect(r.success).toBe(false);
  });

  it("REVIEW_DECISIONS đúng 2 lựa chọn — không có 'promoted' (promote là bước riêng)", () => {
    expect(REVIEW_DECISIONS).toEqual(["approved", "changes_requested"]);
  });
});
