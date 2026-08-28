import { describe, expect, it } from "vitest";
import { resolveChains } from "./phase1-chains.js";
import type { AuthoredCase, CompileSnapshot } from "./snapshot.js";

function kase(id: string, prereqCaseId?: string): AuthoredCase {
  const base = { id, revisionId: `rev-${id}`, name: id, isStepGroup: false, steps: [] as const };
  return prereqCaseId === undefined ? base : { ...base, prereqCaseId };
}

function snap(cases: AuthoredCase[], targets: string[]): CompileSnapshot {
  return {
    teamId: "t1",
    projectId: "p1",
    targetCaseIds: targets,
    cases: Object.fromEntries(cases.map((c) => [c.id, c])),
    elements: {},
    dataProfiles: {},
    env: { baseUrl: "https://app.example", vars: {}, secretNames: [] },
  };
}

describe("phase 1 — resolve prereq chains", () => {
  it("single chain: login first, case second", () => {
    const r = resolveChains(snap([kase("login"), kase("checkout", "login")], ["checkout"]));
    expect(r.diagnostics).toEqual([]);
    expect(r.chains).toEqual([{ chainKey: "checkout", caseIds: ["login", "checkout"] }]);
  });

  it("case with no prereq: single-element chain", () => {
    const r = resolveChains(snap([kase("solo")], ["solo"]));
    expect(r.chains).toEqual([{ chainKey: "solo", caseIds: ["solo"] }]);
  });

  it("cycle A→B→A ⇒ prereq_cycle, no chain", () => {
    const a = kase("A", "B");
    const b = kase("B", "A");
    const r = resolveChains(snap([a, b], ["A"]));
    expect(r.chains).toEqual([]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ severity: "error", code: "prereq_cycle", caseId: "A" }),
    ]);
  });

  it("5 ancestors deep is OK; 6 deep ⇒ prereq_depth_exceeded", () => {
    // c0←c1←...←c5 (5 ancestors for c5) — valid under the rule inherited from the old system
    const ok = [kase("c0"), kase("c1", "c0"), kase("c2", "c1"), kase("c3", "c2"), kase("c4", "c3"), kase("c5", "c4")];
    expect(resolveChains(snap(ok, ["c5"])).diagnostics).toEqual([]);
    const deep = [...ok.map((c) => ({ ...c })), kase("c6", "c5")];
    const r = resolveChains(snap(deep, ["c6"]));
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "prereq_depth_exceeded", caseId: "c6" }),
    ]);
  });

  it("prereq points to a case that doesn't exist ⇒ prereq_missing", () => {
    const r = resolveChains(snap([kase("x", "ghost")], ["x"]));
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ code: "prereq_missing", caseId: "x" }),
    ]);
  });

  it("2 targets sharing 1 login ⇒ 2 INDEPENDENT chains, login appears in both (chain = the isolation unit)", () => {
    const r = resolveChains(
      snap([kase("login"), kase("cart", "login"), kase("profile", "login")], ["cart", "profile"]),
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.chains).toEqual([
      { chainKey: "cart", caseIds: ["login", "cart"] },
      { chainKey: "profile", caseIds: ["login", "profile"] },
    ]);
  });

  it("COLLECTS errors: 2 broken targets ⇒ 2 diagnostics, the healthy target still yields a chain", () => {
    const r = resolveChains(
      snap([kase("ok"), kase("bad1", "ghost"), kase("A", "B"), kase("B", "A")], ["ok", "bad1", "A"]),
    );
    expect(r.chains).toEqual([{ chainKey: "ok", caseIds: ["ok"] }]);
    expect(r.diagnostics).toHaveLength(2);
  });
});
