import { describe, expect, it } from "vitest";
import { bindCases } from "./phase3-bind.js";
import { expandCases } from "./phase2-expand.js";
import { resolveCases } from "./phase45-resolve.js";
import { action, actionOn, element, ifStep, kase, profile, snap } from "./test-support.js";
import type { AuthoredStep, DataRow } from "./snapshot.js";
import type { SnapOpts } from "./test-support.js";

/**
 * Phase 4+5 chỉ nhận IR của phase 3 — test luôn đi qua chuỗi thật (expand → bind → resolve),
 * không dựng BoundCase bằng tay: hợp đồng giữa các phase mới là thứ đáng kiểm.
 */
function resolveOf(
  steps: readonly AuthoredStep[],
  opts: SnapOpts = {},
  caseOpts: { readonly dataProfileId?: string } = {},
): ReturnType<typeof resolveCases> {
  const main = kase("main", steps, caseOpts);
  const snapshot = snap([main], ["main"], opts);
  const bound = bindCases(expandCases(snapshot, ["main"]).cases);
  expect(bound.diagnostics).toEqual([]); // lỗi phase 3 phải không tồn tại: test này soi phase 4+5
  return resolveCases(bound.cases, snapshot);
}

describe("phase 4 — element → LocatorSet", () => {
  it("step có elementId ⇒ StepPlan mang LocatorSet lấy từ snapshot.elements", () => {
    const r = resolveOf([actionOn(1, "web.click", "el-login")], {
      elements: [element("el-login", "ready", [
        { kind: "css", value: "#login" },
        { kind: "xpath", value: "//button[@id='login']" },
      ])],
    });

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind === "action" && step.locators).toEqual({
      elementId: "el-login",
      elementName: "el-login",
      locators: [
        { kind: "css", value: "#login" },
        { kind: "xpath", value: "//button[@id='login']" },
      ],
    });
  });

  it("element status pending_locator ⇒ element_pending_locator kèm caseId + ordinal, step bị loại", () => {
    const r = resolveOf([actionOn(7, "web.click", "el-ghost")], {
      elements: [element("el-ghost", "pending_locator")],
    });

    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "element_pending_locator",
        caseId: "main",
        stepOrdinal: 7,
      }),
    ]);
    expect(r.diagnostics[0]?.message).toContain("el-ghost");
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("element ready nhưng KHÔNG có locator nào ⇒ vẫn là element_pending_locator", () => {
    const r = resolveOf([actionOn(1, "web.click", "el-empty")], {
      elements: [element("el-empty", "ready", [])],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_pending_locator"]);
  });

  it("elementId không có trong snapshot ⇒ element_not_found", () => {
    const r = resolveOf([actionOn(2, "web.click", "el-khong-ton-tai")], { elements: [] });

    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "element_not_found",
        caseId: "main",
        stepOrdinal: 2,
      }),
    ]);
    expect(r.diagnostics[0]?.message).toContain("el-khong-ton-tai");
  });

  it("GOM: 2 element hỏng ⇒ 2 diagnostics, step lành vẫn ở lại IR", () => {
    const r = resolveOf(
      [
        actionOn(1, "web.click", "el-mat"),
        actionOn(2, "web.click", "el-ok"),
        actionOn(3, "web.click", "el-cho-locator"),
      ],
      { elements: [element("el-ok"), element("el-cho-locator", "pending_locator")] },
    );

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_not_found", "element_pending_locator"]);
    expect(r.diagnostics.map((d) => d.stepOrdinal)).toEqual([1, 3]);
    expect(r.cases[0]?.steps.map((s) => s.ordinal)).toEqual([2]);
  });

  it("step không tham chiếu element ⇒ không có locators, không diagnostic", () => {
    const r = resolveOf([action(1, "web.enter", { element: "literal", value: "x" })]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind === "action" && step.locators).toBeUndefined();
  });

  it("element hỏng nằm sâu trong children ⇒ diagnostic mang ordinal của step con", () => {
    const r = resolveOf([ifStep(1, [actionOn(4, "web.click", "el-mat")])], { elements: [] });

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "element_not_found", caseId: "main", stepOrdinal: 4 }),
    ]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind).toBe("if");
    expect(node?.kind !== "action" && node?.children).toEqual([]);
  });
});

describe("phase 5 — secret: chỉ là REF, không bao giờ là giá trị", () => {
  it("$secret:NAME hợp lệ ⇒ arg giữ NGUYÊN dạng ref trong plan (không inline giá trị)", () => {
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-pw", { value: "$secret:ADMIN_PW" })],
      { elements: [element("el-pw")], secretNames: ["ADMIN_PW"] },
    );

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "$secret:ADMIN_PW" });
  });

  it("NAME không có trong env.secretNames ⇒ secret_ref_unknown kèm ordinal + tên secret", () => {
    const r = resolveOf(
      [actionOn(3, "web.enter", "el-pw", { value: "$secret:GO_NHAM" })],
      { elements: [element("el-pw")], secretNames: ["ADMIN_PW"] },
    );

    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "secret_ref_unknown",
        caseId: "main",
        stepOrdinal: 3,
      }),
    ]);
    expect(r.diagnostics[0]?.message).toContain("GO_NHAM");
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("env.secretNames rỗng ⇒ mọi secret ref đều unknown (không có secret nào là mặc định an toàn)", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-pw", { value: "$secret:BAT_KY" })], {
      elements: [element("el-pw")],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["secret_ref_unknown"]);
  });

  it("GOM: element hỏng + secret lạ trên CÙNG step ⇒ 2 diagnostics", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-mat", { value: "$secret:LA" })], {
      elements: [],
      secretNames: [],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_not_found", "secret_ref_unknown"]);
  });
});

describe("phase 5 — merge data-driven + env vào args", () => {
  const rows: readonly DataRow[] = [
    { label: "admin", expectedToFail: false, values: { user: "admin", "Ho Ten": "Quản trị" } },
    { label: "khoá", expectedToFail: true, values: { user: "locked", "Ho Ten": "Bị khoá" } },
  ];

  it("$data:COT lấy giá trị từ hàng của CHÍNH iteration đó", () => {
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-user", { value: "$data:user" })],
      { elements: [element("el-user")], dataProfiles: [profile("p-users", rows)] },
      { dataProfileId: "p-users" },
    );

    expect(r.diagnostics).toEqual([]);
    expect(r.cases).toHaveLength(2);
    expect(r.cases.map((c) => c.steps[0]?.args)).toEqual([{ value: "admin" }, { value: "locked" }]);
    expect(r.cases.map((c) => c.iterationLabel)).toEqual(["admin", "khoá"]);
    expect(r.cases.map((c) => c.expectedToFail)).toEqual([false, true]);
  });

  it("tên cột có dấu cách vẫn merge được", () => {
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-user", { value: "$data:Ho Ten" })],
      { elements: [element("el-user")], dataProfiles: [profile("p-users", rows)] },
      { dataProfileId: "p-users" },
    );

    expect(r.cases.map((c) => c.steps[0]?.args)).toEqual([{ value: "Quản trị" }, { value: "Bị khoá" }]);
  });

  it("$env:VAR lấy giá trị từ env.vars", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-host", { value: "$env:tenant" })], {
      elements: [element("el-host")],
      vars: { tenant: "acme-uat" },
    });

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "acme-uat" });
  });

  it("chuỗi không phải ref giữ nguyên tuyệt đối (kể cả có ký tự $)", () => {
    const r = resolveOf(
      [
        actionOn(1, "web.enter", "el-a", { value: "giá 100$ nhé" }),
        actionOn(2, "web.enter", "el-a", { value: "$khong_biet:x" }),
        actionOn(3, "web.enter", "el-a", { value: "$secret" }),
      ],
      { elements: [element("el-a")], vars: { x: "KHONG_DUOC_DUNG" } },
    );

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps.map((s) => s.args)).toEqual([
      { value: "giá 100$ nhé" },
      { value: "$khong_biet:x" },
      { value: "$secret" },
    ]);
  });

  it("ref trỏ cột/biến không tồn tại ⇒ giữ nguyên ref (vòng for resolve theo hàng lúc chạy)", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-a", { value: "$data:cot_cua_vong_for" })], {
      elements: [element("el-a")],
    });

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "$data:cot_cua_vong_for" });
  });

  it("MỘT pass duy nhất: giá trị đã thay không bị diễn giải lại thành ref", () => {
    const sneaky: readonly DataRow[] = [
      { label: "r1", expectedToFail: false, values: { a: "$data:b", b: "KHONG_DUOC_LO" } },
    ];
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-a", { value: "$data:a" })],
      { elements: [element("el-a")], dataProfiles: [profile("p", sneaky)] },
      { dataProfileId: "p" },
    );

    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "$data:b" });
  });

  it("args của step trong children cũng được merge", () => {
    const r = resolveOf(
      [ifStep(1, [actionOn(2, "web.enter", "el-a", { value: "$env:tenant" })])],
      { elements: [element("el-a")], vars: { tenant: "acme-uat" } },
    );

    const node = r.cases[0]?.steps[0];
    const child = node?.kind !== "action" ? node?.children[0] : undefined;
    expect(child?.args).toEqual({ value: "acme-uat" });
  });
});

describe("phase 4+5 — GOM xuyên case và fan-out", () => {
  it("case data-driven 3 hàng, element hỏng ⇒ CHỈ 1 diagnostic (không nhân bản theo hàng)", () => {
    const many: readonly DataRow[] = [
      { label: "a", expectedToFail: false, values: { user: "a" } },
      { label: "b", expectedToFail: false, values: { user: "b" } },
      { label: "c", expectedToFail: false, values: { user: "c" } },
    ];
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-mat", { value: "$data:user" })],
      { elements: [], dataProfiles: [profile("p", many)] },
      { dataProfileId: "p" },
    );

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_not_found"]);
    expect(r.cases).toHaveLength(3);
  });

  it("GOM xuyên case: mỗi diagnostic mang caseId của case hỏng, giữ thứ tự chain", () => {
    const login = kase("login", [actionOn(1, "web.click", "el-mat")]);
    const main = kase("main", [actionOn(1, "web.enter", "el-ok", { value: "$secret:LA" })], {
      prereqCaseId: "login",
    });
    const snapshot = snap([login, main], ["main"], { elements: [element("el-ok")] });
    const bound = bindCases(expandCases(snapshot, ["login", "main"]).cases);

    const r = resolveCases(bound.cases, snapshot);

    expect(r.diagnostics.map((d) => [d.caseId, d.code])).toEqual([
      ["login", "element_not_found"],
      ["main", "secret_ref_unknown"],
    ]);
  });

  it("CasePlan giữ nguyên metadata phase 2/3 (revisionId, iterationLabel, expectedToFail)", () => {
    const r = resolveOf(
      [actionOn(1, "web.click", "el-a")],
      {
        elements: [element("el-a")],
        dataProfiles: [profile("p", [{ label: "admin", expectedToFail: true, values: {} }])],
      },
      { dataProfileId: "p" },
    );

    expect(r.cases[0]).toEqual(
      expect.objectContaining({
        caseId: "main",
        revisionId: "rev-main",
        expectedToFail: true,
        iterationLabel: "admin",
      }),
    );
  });

  it("không có case nào ⇒ phase rỗng hợp lệ", () => {
    expect(resolveCases([], snap([], []))).toEqual({ cases: [], diagnostics: [] });
  });
});
