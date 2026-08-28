import { describe, expect, it } from "vitest";
import { bindCases } from "./phase3-bind.js";
import { expandCases } from "./phase2-expand.js";
import { resolveCases } from "./phase45-resolve.js";
import { action, actionOn, element, ifStep, kase, profile, snap } from "./test-support.js";
import type { AuthoredStep, DataRow } from "./snapshot.js";
import type { SnapOpts } from "./test-support.js";

/**
 * Phase 4+5 only accepts phase 3's IR — tests always go through the real chain
 * (expand → bind → resolve), never hand-build a BoundCase: the contract between phases is
 * what's worth checking.
 */
function resolveOf(
  steps: readonly AuthoredStep[],
  opts: SnapOpts = {},
  caseOpts: { readonly dataProfileId?: string } = {},
): ReturnType<typeof resolveCases> {
  const main = kase("main", steps, caseOpts);
  const snapshot = snap([main], ["main"], opts);
  const bound = bindCases(expandCases(snapshot, ["main"]).cases);
  expect(bound.diagnostics).toEqual([]); // phase 3 must have no errors: this test is examining phase 4+5
  return resolveCases(bound.cases, snapshot);
}

describe("phase 4 — element → LocatorSet", () => {
  it("a step with elementId ⇒ the StepPlan carries a LocatorSet taken from snapshot.elements", () => {
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

  it("element status pending_locator ⇒ element_pending_locator with caseId + ordinal, step dropped", () => {
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

  it("element ready but with NO locators at all ⇒ still element_pending_locator", () => {
    const r = resolveOf([actionOn(1, "web.click", "el-empty")], {
      elements: [element("el-empty", "ready", [])],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_pending_locator"]);
  });

  it("elementId not in the snapshot ⇒ element_not_found", () => {
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

  it("COLLECTS: 2 broken elements ⇒ 2 diagnostics, the healthy step stays in the IR", () => {
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

  it("a step referencing no element ⇒ no locators, no diagnostic", () => {
    const r = resolveOf([action(1, "web.enter", { element: "literal", value: "x" })]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind === "action" && step.locators).toBeUndefined();
  });

  it("a broken element deep in children ⇒ the diagnostic carries the child step's ordinal", () => {
    const r = resolveOf([ifStep(1, [actionOn(4, "web.click", "el-mat")])], { elements: [] });

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "element_not_found", caseId: "main", stepOrdinal: 4 }),
    ]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind).toBe("if");
    expect(node?.kind !== "action" && node?.children).toEqual([]);
  });
});

describe("phase 5 — secret: only ever a REF, never a value", () => {
  it("a valid $secret:NAME ⇒ the arg STAYS in ref form in the plan (value never inlined)", () => {
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-pw", { value: "$secret:ADMIN_PW" })],
      { elements: [element("el-pw")], secretNames: ["ADMIN_PW"] },
    );

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "$secret:ADMIN_PW" });
  });

  it("NAME not in env.secretNames ⇒ secret_ref_unknown with ordinal + secret name", () => {
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

  it("an empty env.secretNames ⇒ every secret ref is unknown (no secret is a safe default)", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-pw", { value: "$secret:BAT_KY" })], {
      elements: [element("el-pw")],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["secret_ref_unknown"]);
  });

  it("COLLECTS: a broken element + an unknown secret on the SAME step ⇒ 2 diagnostics", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-mat", { value: "$secret:LA" })], {
      elements: [],
      secretNames: [],
    });

    expect(r.diagnostics.map((d) => d.code)).toEqual(["element_not_found", "secret_ref_unknown"]);
  });
});

describe("phase 5 — merge data-driven + env into args", () => {
  const rows: readonly DataRow[] = [
    { label: "admin", expectedToFail: false, values: { user: "admin", "Ho Ten": "Quản trị" } },
    { label: "khoá", expectedToFail: true, values: { user: "locked", "Ho Ten": "Bị khoá" } },
  ];

  it("$data:COLUMN takes its value from THIS iteration's own row", () => {
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

  it("a column name with a space still merges fine", () => {
    const r = resolveOf(
      [actionOn(1, "web.enter", "el-user", { value: "$data:Ho Ten" })],
      { elements: [element("el-user")], dataProfiles: [profile("p-users", rows)] },
      { dataProfileId: "p-users" },
    );

    expect(r.cases.map((c) => c.steps[0]?.args)).toEqual([{ value: "Quản trị" }, { value: "Bị khoá" }]);
  });

  it("$env:VAR takes its value from env.vars", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-host", { value: "$env:tenant" })], {
      elements: [element("el-host")],
      vars: { tenant: "acme-uat" },
    });

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "acme-uat" });
  });

  it("a string that isn't a ref is kept absolutely as-is (even with a $ character)", () => {
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

  it("a ref pointing to a nonexistent column/var ⇒ kept as-is (a for loop resolves per-row at run time)", () => {
    const r = resolveOf([actionOn(1, "web.enter", "el-a", { value: "$data:cot_cua_vong_for" })], {
      elements: [element("el-a")],
    });

    expect(r.diagnostics).toEqual([]);
    expect(r.cases[0]?.steps[0]?.args).toEqual({ value: "$data:cot_cua_vong_for" });
  });

  it("EXACTLY ONE pass: a substituted value is not re-interpreted as a ref", () => {
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

  it("args of a step inside children are also merged", () => {
    const r = resolveOf(
      [ifStep(1, [actionOn(2, "web.enter", "el-a", { value: "$env:tenant" })])],
      { elements: [element("el-a")], vars: { tenant: "acme-uat" } },
    );

    const node = r.cases[0]?.steps[0];
    const child = node?.kind !== "action" ? node?.children[0] : undefined;
    expect(child?.args).toEqual({ value: "acme-uat" });
  });
});

describe("phase 4+5 — COLLECTS across cases and fan-out", () => {
  it("a data-driven case with 3 rows, a broken element ⇒ ONLY 1 diagnostic (not duplicated per row)", () => {
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

  it("COLLECTS across cases: each diagnostic carries the caseId of the broken case, chain order preserved", () => {
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

  it("CasePlan keeps phase 2/3 metadata unchanged (revisionId, iterationLabel, expectedToFail)", () => {
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

  it("no cases at all ⇒ an empty phase is valid", () => {
    expect(resolveCases([], snap([], []))).toEqual({ cases: [], diagnostics: [] });
  });
});
