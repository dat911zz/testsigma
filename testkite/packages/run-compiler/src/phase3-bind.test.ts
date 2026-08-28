import { describe, expect, it } from "vitest";
import { bindCases } from "./phase3-bind.js";
import { expandCases } from "./phase2-expand.js";
import { action, actionOn, forStep, ifStep, kase, profile, snap, whileStep } from "./test-support.js";
import type { AuthoredStep } from "./snapshot.js";

/** phase 2 is phase 3's only valid input — tests always go through it, never hand-build the IR. */
function bindOf(steps: readonly AuthoredStep[], caseId = "main"): ReturnType<typeof bindCases> {
  const main = kase(caseId, steps);
  return bindCases(expandCases(snap([main], [caseId]), [caseId]).cases);
}

describe("phase 3 — bind verb: opKey", () => {
  it("a verb in the registry ⇒ the step binds, keeping opKey + renderedSentence", () => {
    const r = bindOf([actionOn(1, "web.click", "el-login", {}, "Click on login")]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind).toBe("action");
    expect(step?.kind === "action" && step.opKey).toBe("web.click");
    expect(step?.renderedSentence).toBe("Click on login");
  });

  it("unknown opKey ⇒ unknown_verb with caseId + stepOrdinal, step dropped from the IR", () => {
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

  it("COLLECTS: 2 unknown verbs in 1 case ⇒ 2 diagnostics (no first-fail)", () => {
    const r = bindOf([
      actionOn(1, "web.telepathy", "el-a"),
      actionOn(2, "web.click", "el-b"),
      actionOn(3, "web.astral-projection", "el-c"),
    ]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb", "unknown_verb"]);
    expect(r.diagnostics.map((d) => d.stepOrdinal)).toEqual([1, 3]);
    expect(r.cases[0]?.steps.map((s) => s.ordinal)).toEqual([2]);
  });

  it("an action step with NO verbOpKey declared ⇒ unknown_verb", () => {
    const orphan: AuthoredStep = { ordinal: 1, kind: "action", args: {}, renderedSentence: "???" };

    const r = bindOf([orphan]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_verb", caseId: "main", stepOrdinal: 1 }),
    ]);
  });
});

describe("phase 3 — bind verb: args", () => {
  it("args missing a required param ⇒ verb_args_invalid with stepOrdinal + param name", () => {
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

  it("a step's elementRef substitutes for the `element` arg (phase 4 is where the locator is resolved)", () => {
    const r = bindOf([actionOn(1, "web.enter", "el-user", { value: "admin" })]);

    expect(r.diagnostics).toEqual([]);
    const step = r.cases[0]?.steps[0];
    expect(step?.kind === "action" && step.elementId).toBe("el-user");
    expect(step?.args).toEqual({ value: "admin" });
  });

  it("web.click with no element (neither args nor elementRef) ⇒ verb_args_invalid", () => {
    const r = bindOf([action(2, "web.click")]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["verb_args_invalid"]);
    expect(r.diagnostics[0]?.stepOrdinal).toBe(2);
  });

  it("COLLECTS: an unknown verb + broken args in the same case ⇒ 2 diagnostics in step order", () => {
    const r = bindOf([
      actionOn(1, "web.ghost", "el-a"),
      action(2, "web.enter", { element: "el-user" }),
    ]);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb", "verb_args_invalid"]);
  });
});

describe("phase 3 — bind verb: recursion into structural nodes", () => {
  it("if/for/while keep the node + bind children, no verb required for the node itself", () => {
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

  it("an unknown verb deep in children ⇒ still produces a diagnostic with the child step's ordinal", () => {
    const r = bindOf([ifStep(1, [actionOn(2, "web.hypnotize", "el-x")])]);

    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_verb", caseId: "main", stepOrdinal: 2 }),
    ]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind !== "action" && node?.children).toEqual([]);
  });

  it("for keeps the loopRows resolved in phase 2", () => {
    const rows = [{ label: "r1", expectedToFail: false, values: { user: "a" } }];
    const main = kase("main", [forStep(1, [actionOn(1, "web.click", "el-row")], "p-loop")]);

    const expansion = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-loop", rows)] }), ["main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics).toEqual([]);
    const node = r.cases[0]?.steps[0];
    expect(node?.kind !== "action" && node?.loopRows).toEqual(rows);
  });
});

describe("phase 3 — bind verb: multiple cases / data-driven fan-out", () => {
  it("COLLECTS across cases: each diagnostic carries the caseId of the case that's actually broken", () => {
    const login = kase("login", [actionOn(1, "web.seance", "el-a")]);
    const main = kase("main", [action(1, "web.enter", { element: "el-user" })], { prereqCaseId: "login" });

    const expansion = expandCases(snap([login, main], ["main"]), ["login", "main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics.map((d) => [d.caseId, d.code])).toEqual([
      ["login", "unknown_verb"],
      ["main", "verb_args_invalid"],
    ]);
  });

  it("a data-driven case with 3 rows ⇒ 3 BoundCases but the unknown verb is only reported once", () => {
    const rows = [
      { label: "admin", expectedToFail: false, values: { user: "admin" } },
      { label: "locked", expectedToFail: true, values: { user: "locked" } },
      { label: "guest", expectedToFail: false, values: { user: "guest" } },
    ];
    const main = kase("main", [actionOn(1, "web.ouija", "el-a")], { dataProfileId: "p-users" });

    const expansion = expandCases(snap([main], ["main"], { dataProfiles: [profile("p-users", rows)] }), ["main"]);
    const r = bindCases(expansion.cases);

    expect(r.diagnostics.map((d) => d.code)).toEqual(["unknown_verb"]);
    expect(r.cases).toHaveLength(3);
  });

  it("BoundCase keeps phase 2's iteration metadata unchanged", () => {
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

  it("no cases at all ⇒ no diagnostics (an empty phase is valid)", () => {
    expect(bindCases([])).toEqual({ cases: [], diagnostics: [] });
  });
});
