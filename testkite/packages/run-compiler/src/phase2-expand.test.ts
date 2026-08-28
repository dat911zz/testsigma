import { describe, expect, it } from "vitest";
import { expandCases, MAX_STEP_GROUP_DEPTH } from "./phase2-expand.js";
import { action, forStep, groupCall, ifStep, kase, profile, snap, whileStep } from "./test-support.js";

describe("phase 2 — structural expansion: step group", () => {
  it("a 3-step group ⇒ the case sees 3 flat steps, original renderedSentence kept", () => {
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

  it("an inlined step carries groupPath provenance = ids of the expanded groups", () => {
    const inner = kase("inner", [action(1, "web.click")], { isStepGroup: true });
    const outer = kase("outer", [groupCall(1, "inner")], { isStepGroup: true });
    const main = kase("main", [action(1, "web.click"), groupCall(2, "outer")]);

    const r = expandCases(snap([inner, outer, main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps.map((s) => s.groupPath)).toEqual([[], ["outer", "inner"]]);
  });

  it(`${MAX_STEP_GROUP_DEPTH} levels of group nesting is OK, ${MAX_STEP_GROUP_DEPTH + 1} levels ⇒ step_group_depth_exceeded`, () => {
    const groups = [1, 2, 3, 4, 5, 6].map((n) =>
      kase(`g${n}`, n === 6 ? [action(1, "web.click")] : [groupCall(1, `g${n + 1}`)], { isStepGroup: true }),
    );
    const okCase = kase("ok", [groupCall(1, "g2")]); // g2..g6 = 5 levels
    const deepCase = kase("deep", [groupCall(1, "g1")]); // g1..g6 = 6 levels

    const ok = expandCases(snap([...groups, okCase], ["ok"]), ["ok"]);
    expect(ok.diagnostics).toEqual([]);

    const deep = expandCases(snap([...groups, deepCase], ["deep"]), ["deep"]);
    expect(deep.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "step_group_depth_exceeded", caseId: "deep" }),
    ]);
  });

  it("a group calling itself ⇒ step_group_depth_exceeded (the cycle is caught via the depth cap)", () => {
    const loop = kase("loop", [groupCall(1, "loop")], { isStepGroup: true });
    const main = kase("main", [groupCall(1, "loop")]);

    const r = expandCases(snap([loop, main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "step_group_depth_exceeded", caseId: "main" }),
    ]);
    expect(r.cases[0]?.steps).toEqual([]);
  });

  it("step_group points to a case that doesn't exist ⇒ step_group_missing", () => {
    const main = kase("main", [groupCall(2, "ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "step_group_missing", caseId: "main", stepOrdinal: 2 }),
    ]);
  });
});

describe("phase 2 — structural expansion: if/for/while block", () => {
  it("if stays a conditional node with children", () => {
    const main = kase("main", [ifStep(1, [action(1, "web.click"), action(2, "web.enter")], ["SUCCESS"])]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    const node = r.cases[0]?.steps[0];
    expect(node?.kind).toBe("if");
    expect(node?.conditionExpected).toEqual(["SUCCESS"]);
    expect(node?.children?.map((c) => c.kind)).toEqual(["action", "action"]);
  });

  it("for attaches the profile's DataRows to the loop node", () => {
    const rows = [
      { label: "r1", expectedToFail: false, values: { user: "a" } },
      { label: "r2", expectedToFail: false, values: { user: "b" } },
    ];
    const main = kase("main", [forStep(1, [action(1, "web.click")], "p-loop")]);

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-loop", rows)] }), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.loopRows).toEqual(rows);
  });

  it("for points to an empty profile ⇒ data_profile_empty with stepOrdinal", () => {
    const main = kase("main", [forStep(3, [action(1, "web.click")], "p-empty")]);

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-empty", [])] }), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main", stepOrdinal: 3 }),
    ]);
  });

  it("for points to a profile missing from the snapshot ⇒ data_profile_empty", () => {
    const main = kase("main", [forStep(1, [action(1, "web.click")], "p-ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main", stepOrdinal: 1 }),
    ]);
  });

  it("while missing maxIterations ⇒ while_without_max_iterations", () => {
    const main = kase("main", [whileStep(4, [action(1, "web.click")])]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "while_without_max_iterations", caseId: "main", stepOrdinal: 4 }),
    ]);
  });

  it("while with maxIterations ⇒ keeps the iteration cap on the node", () => {
    const main = kase("main", [whileStep(1, [action(1, "web.click")], 7)]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.maxIterations).toBe(7);
  });

  it("COLLECTS errors: a broken while and a broken for in the same case ⇒ 2 diagnostics", () => {
    const main = kase("main", [whileStep(1, []), forStep(2, [], "p-ghost")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.diagnostics.map((d) => d.code)).toEqual([
      "while_without_max_iterations",
      "data_profile_empty",
    ]);
  });
});

describe("phase 2 — data-driven fan-out", () => {
  it("a case with 3 rows ⇒ 3 iterations, label taken from the row, expected_to_fail flag preserved", () => {
    const rows = [
      { label: "admin", expectedToFail: false, values: { user: "admin" } },
      { label: "locked", expectedToFail: true, values: { user: "locked" } },
      { label: "guest", expectedToFail: false, values: { user: "guest" } },
    ];
    const main = kase("main", [action(1, "web.click")], { dataProfileId: "p-users" });

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-users", rows)] }), ["main"]);

    expect(r.diagnostics).toEqual([]);
    expect(r.cases.map((c) => c.iterationLabel)).toEqual(["admin", "locked", "guest"]);
    expect(r.cases.map((c) => c.expectedToFail)).toEqual([false, true, false]);
    expect(r.cases.map((c) => c.dataRow)).toEqual(rows.map((row) => row.values));
  });

  it("a case that is NOT data-driven ⇒ exactly 1 iteration, no iterationLabel", () => {
    const main = kase("main", [action(1, "web.click")]);

    const r = expandCases(snap([main], ["main"]), ["main"]);

    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.iterationLabel).toBeUndefined();
    expect(r.cases[0]?.expectedToFail).toBe(false);
    expect(r.cases[0]?.revisionId).toBe("rev-main");
  });

  it("a data-driven case pointing to an empty profile ⇒ data_profile_empty at the case level", () => {
    const main = kase("main", [action(1, "web.click")], { dataProfileId: "p-empty" });

    const r = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-empty", [])] }), ["main"]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "data_profile_empty", caseId: "main" }),
    ]);
    expect(r.cases).toEqual([]);
  });

  it("expands the whole chain: keeps [prereq, target] order", () => {
    const login = kase("login", [action(1, "web.enter")]);
    const main = kase("main", [action(1, "web.click")], { prereqCaseId: "login" });

    const r = expandCases(snap([login, main], ["main"]), ["login", "main"]);

    expect(r.cases.map((c) => c.caseId)).toEqual(["login", "main"]);
  });
});
