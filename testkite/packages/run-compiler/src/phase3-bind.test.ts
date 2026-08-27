import { describe, expect, it } from "vitest";
import { bindCases } from "./phase3-bind.js";
import { expandCases } from "./phase2-expand.js";
import { action, actionOn, forStep, ifStep, kase, profile, snap, whileStep } from "./test-support.js";
import type { AuthoredStep } from "./snapshot.js";

/** phase 2 là input hợp lệ duy nhất của phase 3 — test luôn đi qua nó, không dựng IR bằng tay. */
function bindOf(steps: readonly AuthoredStep[], caseId = "main"): ReturnType<typeof bindCases> {
  const main = kase(caseId, steps);
  return bindCases(expandCases(snap([main], [caseId]), [caseId]).cases);
}

describe("phase 3 — bind verb: opKey", () => {
  it("verb có trong registry ⇒ step bind được, giữ opKey + renderedSentence", () => {
    const r = bindOf([actionOn(1, "web.click", "el-login", {}, "Click on login")]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind).toBe("action");
    expect(step?.kind === "action" && step.opKey).toBe("web.click");
    expect(step?.renderedSentence).toBe("Click on login");
  });

  it("opKey lạ ⇒ unknown_verb kèm caseId + stepOrdinal, step bị loại khỏi IR", () => {
    const r = bindOf([actionOn(3, "web.telepathy", "el-login")]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "unknown_verb",
        caseId: "main",
        stepOrdinal: 3,
      }),
    ]);
    expect(r.diagnostics[0]?.message).toContain("web.telepathy");
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("GOM: 2 verb lạ trong 1 case ⇒ 2 diagnostics (không first-fail)", () => {
    const r = bindOf([
      actionOn(1, "web.telepathy", "el-a"),
      actionOn(2, "web.click", "el-b"),
      actionOn(3, "web.astral-projection", "el-c"),
    ]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb", "unknown_verb"]);
    expect(r.diagnostics.map((d) => d.stepOrdinal)).toEqual([1, 3]);
    expect(r.cases[0]?.steps.map((s) => s.ordinal)).toEqual([2]);
  });

  it("step action KHÔNG khai báo verbOpKey ⇒ unknown_verb", () => {
    const orphan: AuthoredStep = { ordinal: 1, kind: "action", args: {}, renderedSentence: "???" };

    const r = bindOf([orphan]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_verb", caseId: "main", stepOrdinal: 1 }),
    ]);
  });
});

describe("phase 3 — bind verb: args", () => {
  it("args thiếu param required ⇒ verb_args_invalid kèm stepOrdinal + tên param", () => {
    const r = bindOf([action(4, "web.enter", { element: "el-user" })]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "verb_args_invalid",
        caseId: "main",
        stepOrdinal: 4,
      }),
    ]);
    expect(r.diagnostics[0]?.message).toContain("value");
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("elementRef của step thế chỗ arg `element` (phase 4 mới resolve locator)", () => {
    const r = bindOf([actionOn(1, "web.enter", "el-user", { value: "admin" })]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind === "action" && step.elementId).toBe("el-user");
    expect(step?.args).toEqual({ value: "admin" });
  });

  it("web.click không element (cả args lẫn elementRef) ⇒ verb_args_invalid", () => {
    const r = bindOf([action(2, "web.click")]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["verb_args_invalid"]);
    expect(r.diagnostics[0]?.stepOrdinal).toBe(2);
  });

  it("GOM: verb lạ + args hỏng trong cùng case ⇒ 2 diagnostics đúng thứ tự step", () => {
    const r = bindOf([
      actionOn(1, "web.ghost", "el-a"),
      action(2, "web.enter", { element: "el-user" }),
    ]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb", "verb_args_invalid"]);
  });
});

describe("phase 3 — bind verb: đệ quy node cấu trúc", () => {
  it("if/for/while giữ nguyên node + bind children, không đòi verb cho chính node", () => {
    const r = bindOf(
      [ifStep(1, [actionOn(1, "web.click", "el-ok"), whileStep(2, [actionOn(1, "web.click", "el-in")], 3)])],
      "main",
    );

    expect(r.diagnostics).toEqual([]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind).toBe("if");
    expect(node?.kind !== "action" && node?.children.map((c) => c.kind)).toEqual(["action", "while"]);
    const inner = node?.kind !== "action" ? node?.children[1] : undefined;
    expect(inner?.kind !== "action" && inner?.maxIterations).toBe(3);
    expect(inner?.kind !== "action" && inner?.children.map((c) => c.kind)).toEqual(["action"]);
  });

  it("verb lạ nằm sâu trong children ⇒ vẫn ra diagnostic kèm ordinal của step con", () => {
    const r = bindOf([ifStep(1, [actionOn(2, "web.hypnotize", "el-x")])]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_verb", caseId: "main", stepOrdinal: 2 }),
    ]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind !== "action" && node?.children).toEqual([]);
  });

  it("for giữ loopRows đã resolve ở phase 2", () => {
    const rows = [{ label: "r1", expectedToFail: false, values: { user: "a" } }];
    const main = kase("main", [forStep(1, [actionOn(1, "web.click", "el-row")], "p-loop")]);

    const expansion = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-loop", rows)] }), ["main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics).toEqual([]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind !== "action" && node?.loopRows).toEqual(rows);
  });
});

describe("phase 3 — bind verb: nhiều case / fan-out data-driven", () => {
  it("GOM xuyên case: mỗi diagnostic mang caseId của chính case hỏng", () => {
    const login = kase("login", [actionOn(1, "web.seance", "el-a")]);
    const main = kase("main", [action(1, "web.enter", { element: "el-user" })], { prereqCaseId: "login" });

    const expansion = expandCases(snap([login, main], ["main"]), ["login", "main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics.map((d) => [d.caseId, d.code])).toEqual([
      ["login", "unknown_verb"],
      ["main", "verb_args_invalid"],
    ]);
  });

  it("case data-driven 3 hàng ⇒ 3 BoundCase nhưng verb lạ chỉ báo 1 lần", () => {
    const rows = [
      { label: "admin", expectedToFail: false, values: { user: "admin" } },
      { label: "khoá", expectedToFail: true, values: { user: "locked" } },
      { label: "khách", expectedToFail: false, values: { user: "guest" } },
    ];
    const main = kase("main", [actionOn(1, "web.ouija", "el-a")], { dataProfileId: "p-users" });

    const expansion = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-users", rows)] }), ["main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb"]);
    expect(r.cases).toHaveLength(3);
  });

  it("BoundCase giữ nguyên metadata iteration của phase 2", () => {
    const rows = [{ label: "admin", expectedToFail: true, values: { user: "admin" } }];
    const main = kase("main", [actionOn(1, "web.click", "el-a")], { dataProfileId: "p-users" });

    const expansion = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-users", rows)] }), ["main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]).toEqual(
      expect.objectContaining({
        caseId: "main",
        revisionId: "rev-main",
        expectedToFail: true,
        iterationLabel: "admin",
        dataRow: { user: "admin" },
      }),
    );
  });

  it("không có case nào ⇒ không có diagnostic (phase rỗng là hợp lệ)", () => {
    expect(bindCases([])).toEqual({ cases: [], diagnostics: [] });
  });
});
