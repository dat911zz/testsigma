import { describe, expect, it } from "vitest";
import { expandCases, MAX_STEP_GROUP_DEPTH } from "./phase2-expand.js";
import { action, forStep, groupCall, ifStep, kase, profile, snap, whileStep } from "./test-support.js";

describe("phase 2 — nở cấu trúc: step group", () => {
  it("group 3 step ⇒ case thấy 3 step phẳng, giữ renderedSentence gốc", () => {
    const grp = kase(
      "grp",
      [action(1, "web.click", {}, "Click on login"), action(2, "web.enter", {}, "Enter user"), action(3, "web.click", {}, "Click on submit")],
      { isStepGroup: true },
    );
    const main = kase("main", [groupCall(1, "grp")]);

    const r = expandCases(snap([grp, main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.steps.map((s) => s.renderedSentence)).toEqual([
      "Click on login",
      "Enter user",
      "Click on submit",
    ]);
  });

  it("step inline mang provenance groupPath = id các group đã nở", () => {
    const inner = kase("inner", [action(1, "web.click")], { isStepGroup: true });
    const outer = kase("outer", [groupCall(1, "inner")], { isStepGroup: true });
    const main = kase("main", [action(1, "web.click"), groupCall(2, "outer")]);

    const r = expandCases(snap([inner, outer, main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps.map((s) => s.groupPath)).toEqual([[], ["outer", "inner"]]);
  });

  it(`group lồng ${MAX_STEP_GROUP_DEPTH} tầng OK, tầng ${MAX_STEP_GROUP_DEPTH + 1} ⇒ step_group_depth_exceeded`, () => {
    const groups = [1, 2, 3, 4, 5, 6].map((n) =>
      kase(`g${n}`, n === 6 ? [action(1, "web.click")] : [groupCall(1, `g${n + 1}`)], { isStepGroup: true }),
    );
    const okCase = kase("ok", [groupCall(1, "g2")]); // g2..g6 = 5 tầng
    const deepCase = kase("deep", [groupCall(1, "g1")]); // g1..g6 = 6 tầng

    const ok = expandCases(snap([...groups, okCase], ["ok"]), ["ok"]);
    expect(ok.diagnostics).toEqual([]);

    const deep = expandCases(snap([...groups, deepCase], ["deep"]), ["deep"]);
    expect(deep.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "step_group_depth_exceeded", caseId: "deep" }),
    ]);
  });

  it("group tự gọi chính mình ⇒ step_group_depth_exceeded (cycle bắt qua trần depth)", () => {
    const loop = kase("loop", [groupCall(1, "loop")], { isStepGroup: true });
    const main = kase("main", [groupCall(1, "loop")]);

    const r = expandCases(snap([loop, main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "step_group_depth_exceeded", caseId: "main" }),
    ]);
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("step_group trỏ case không tồn tại ⇒ step_group_missing", () => {
    const main = kase("main", [groupCall(2, "ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "step_group_missing", caseId: "main", stepOrdinal: 2 }),
    ]);
  });
});

describe("phase 2 — nở cấu trúc: block if/for/while", () => {
  it("if giữ nguyên là node điều kiện có children", () => {
    const main = kase("main", [ifStep(1, [action(1, "web.click"), action(2, "web.enter")], ["SUCCESS"])]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    const node = r.cases[0]?.steps[0];
    expect(node?.kind).toBe("if");
    expect(node?.conditionExpected).toEqual(["SUCCESS"]);
    expect(node?.children?.map((c) => c.kind)).toEqual(["action", "action"]);
  });

  it("for gắn các DataRow của profile vào node lặp", () => {
    const rows = [
      { label: "r1", expectedToFail: false, values: { user: "a" } },
      { label: "r2", expectedToFail: false, values: { user: "b" } },
    ];
    const main = kase("main", [forStep(1, [action(1, "web.click")], "p-loop")]);

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-loop", rows)] }), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.loopRows).toEqual(rows);
  });

  it("for trỏ profile rỗng ⇒ data_profile_empty kèm stepOrdinal", () => {
    const main = kase("main", [forStep(3, [action(1, "web.click")], "p-empty")]);

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-empty", [])] }), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main", stepOrdinal: 3 }),
    ]);
  });

  it("for trỏ profile không có trong snapshot ⇒ data_profile_empty", () => {
    const main = kase("main", [forStep(1, [action(1, "web.click")], "p-ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main", stepOrdinal: 1 }),
    ]);
  });

  it("while thiếu maxIterations ⇒ while_without_max_iterations", () => {
    const main = kase("main", [whileStep(4, [action(1, "web.click")])]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "while_without_max_iterations", caseId: "main", stepOrdinal: 4 }),
    ]);
  });

  it("while có maxIterations ⇒ giữ trần lặp trên node", () => {
    const main = kase("main", [whileStep(1, [action(1, "web.click")], 7)]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.maxIterations).toBe(7);
  });

  it("GOM lỗi: while hỏng và for hỏng trong cùng case ⇒ 2 diagnostics", () => {
    const main = kase("main", [whileStep(1, []), forStep(2, [], "p-ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "while_without_max_iterations",
      "data_profile_empty",
    ]);
  });
});

describe("phase 2 — fan-out data-driven", () => {
  it("case 3 hàng ⇒ 3 iteration, label lấy từ row, cờ expected_to_fail giữ nguyên", () => {
    const rows = [
      { label: "admin", expectedToFail: false, values: { user: "admin" } },
      { label: "khoá", expectedToFail: true, values: { user: "locked" } },
      { label: "khách", expectedToFail: false, values: { user: "guest" } },
    ];
    const main = kase("main", [action(1, "web.click")], { dataProfileId: "p-users" });

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-users", rows)] }), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases.map((c) => c.iterationLabel)).toEqual(["admin", "khoá", "khách"]);
    expect(r.cases.map((c) => c.expectedToFail)).toEqual([false, true, false]);
    expect(r.cases.map((c) => c.dataRow)).toEqual(rows.map((row) => row.values));
  });

  it("case KHÔNG data-driven ⇒ đúng 1 iteration, không iterationLabel", () => {
    const main = kase("main", [action(1, "web.click")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.iterationLabel).toBeUndefined();
    expect(r.cases[0]?.expectedToFail).toBe(false);
    expect(r.cases[0]?.revisionId).toBe("rev-main");
  });

  it("case data-driven trỏ profile rỗng ⇒ data_profile_empty ở cấp case", () => {
    const main = kase("main", [action(1, "web.click")], { dataProfileId: "p-empty" });

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-empty", [])] }), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main" }),
    ]);
    expect(r.cases).toEqual([]);
  });

  it("nở cả chain: giữ thứ tự [prereq, target]", () => {
    const login = kase("login", [action(1, "web.enter")]);
    const main = kase("main", [action(1, "web.click")], { prereqCaseId: "login" });

    const r = expandCases(snap([login, main], ["main"]), ["login", "main"]);

    expect(r.cases.map((c) => c.caseId)).toEqual(["login", "main"]);
  });
});
