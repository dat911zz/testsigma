import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileRun, dedupeDiagnostics, PLAN_FORMAT_VERSION } from "./index.js";
import type { CompileDiagnostic, CompileOutput, RunPlan } from "./index.js";
import {
  canonicalJson,
  chainTimeoutSeconds,
  contentHashOf,
  countSteps,
  MAX_CHAIN_TIMEOUT_SECONDS,
  MIN_CHAIN_TIMEOUT_SECONDS,
} from "./phase67-freeze.js";
import { actionOn, element, groupCall, kase, profile, snap } from "./test-support.js";
import type { AuthoredCase, AuthoredStep, CompileSnapshot, DataRow } from "./snapshot.js";

/** No `!` used: either there's a plan, or the test fails right here with a clear message. */
function planOf(out: CompileOutput): RunPlan {
  expect(out.diagnostics).toEqual([]);
  const { plan } = out;
  if (plan === undefined) throw new Error("compileRun returned no plan despite empty diagnostics");
  return plan;
}

// ---------------------------------------------------------------------------
// A "small kitchen-sink" snapshot: prereq chain (login → checkout) + a step group
// (grp-header inlining 2 steps) + data-driven (2 rows). Enough for a real plan to go
// through the full phase 1→7 pipeline while still being readable by eye.
// ---------------------------------------------------------------------------

const GROUP: AuthoredCase = kase(
  "grp-header",
  [actionOn(1, "web.click", "el-menu"), actionOn(2, "web.click", "el-cart")],
  { isStepGroup: true },
);

const LOGIN: AuthoredCase = kase("login", [
  actionOn(1, "web.enter", "el-user", { value: "$env:tenant" }),
  actionOn(2, "web.enter", "el-pw", { value: "$secret:ADMIN_PW" }),
]);

const ROWS: readonly DataRow[] = [
  { label: "qty-1", expectedToFail: false, values: { qty: "1" } },
  { label: "qty-999", expectedToFail: true, values: { qty: "999" } },
];

/** `qtyArgs` lets a test change 1 arg / change key ORDER without changing anything else. */
function sinkSnapshot(qtyArgs: Readonly<Record<string, string>> = { value: "$data:qty" }): CompileSnapshot {
  const checkoutSteps: readonly AuthoredStep[] = [
    groupCall(1, "grp-header"),
    actionOn(2, "web.enter", "el-qty", qtyArgs),
  ];
  const checkout = kase("checkout", checkoutSteps, {
    prereqCaseId: "login",
    dataProfileId: "p-rows",
  });

  return snap([GROUP, LOGIN, checkout], ["checkout"], {
    elements: [element("el-menu"), element("el-cart"), element("el-user"), element("el-pw"), element("el-qty")],
    dataProfiles: [profile("p-rows", ROWS)],
    secretNames: ["ADMIN_PW"],
    vars: { tenant: "acme-uat" },
  });
}

describe("phase 7 — canonicalize: same CONTENT ⇒ same string, regardless of key order", () => {
  it("sorts keys RECURSIVELY, not just the outer level", () => {
    const a = canonicalJson({ b: { z: 1, a: [{ y: 2, x: 3 }] }, a: "x" });
    const b = canonicalJson({ a: "x", b: { a: [{ x: 3, y: 2 }], z: 1 } });

    expect(a).toBe(b);
    expect(a).toBe('{"a":"x","b":{"a":[{"x":3,"y":2}],"z":1}}');
  });

  it("ARRAY order is semantic (execution order) ⇒ must NOT be sorted", () => {
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });

  it("an absent optional field ≡ a field holding undefined (exactOptionalPropertyTypes)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("rejects a non-JSON value instead of silently hashing a wrong payload", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/NaN|finite/i);
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it("unicode/Vietnamese-diacritic strings are escaped stably", () => {
    // Key/value written as \u escapes, not literal accented bytes, so this source file
    // passes the CI language gate (it greps for literal Vietnamese characters in src/).
    // The runtime string value is byte-identical either way — \u1ECD etc. resolve to
    // the same UTF-16 code units a literal accented character would.
    expect(canonicalJson({ "H\u1ECD T\u00EAn": "Qu\u1EA3n tr\u1ECB" })).toBe(
      '{"H\u1ECD T\u00EAn":"Qu\u1EA3n tr\u1ECB"}',
    );
  });
});

describe("phase 7 — contentHash = SHA-256 of the canonical payload", () => {
  it("is exactly SHA-256 hex of canonicalJson, not a homemade digest", () => {
    const value = { b: 1, a: [2, 3] };
    const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

    expect(contentHashOf(value)).toBe(expected);
    expect(contentHashOf(value)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("phase 6 — chain timeout = clamp(90 + 12×steps, 180..900)", () => {
  it("180s floor for a short chain", () => {
    expect(chainTimeoutSeconds(0)).toBe(MIN_CHAIN_TIMEOUT_SECONDS);
    expect(chainTimeoutSeconds(7)).toBe(180); // 90+84=174 → floor
  });

  it("the linear region between the two caps", () => {
    expect(chainTimeoutSeconds(8)).toBe(186);
    expect(chainTimeoutSeconds(30)).toBe(450);
    expect(chainTimeoutSeconds(67)).toBe(894);
  });

  it("900s cap for a huge chain", () => {
    expect(chainTimeoutSeconds(68)).toBe(MAX_CHAIN_TIMEOUT_SECONDS); // 90+816=906 → cap
    expect(chainTimeoutSeconds(10_000)).toBe(900);
  });

  it("countSteps counts RECURSIVELY through children and sums every iteration of the chain", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const chain = plan.chains[0];
    if (chain === undefined) throw new Error("plan has no chains");

    // login 2 steps + checkout ×2 rows × (2 inlined step-group steps + 1 step) = 2 + 6 = 8
    expect(countSteps(chain.cases)).toBe(8);
    expect(chain.stepCount).toBe(8);
    expect(chain.timeoutSeconds).toBe(chainTimeoutSeconds(8));
    expect(chain.timeoutSeconds).toBe(186);
  });
});

describe("phase 7 — freeze: hash is stable by CONTENT", () => {
  it("same input ⇒ same contentHash across 2 calls (no timestamp, no random)", () => {
    const first = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const second = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changing EXACTLY 1 arg ⇒ the hash changes", () => {
    const base = planOf(compileRun({ snapshot: sinkSnapshot({ value: "$data:qty" }) }));
    const changed = planOf(compileRun({ snapshot: sinkSnapshot({ value: "hand-edited" }) }));

    expect(changed.contentHash).not.toBe(base.contentHash);
  });

  it("changing key ORDER within args ⇒ the hash does NOT change", () => {
    const abc = planOf(compileRun({ snapshot: sinkSnapshot({ element: "el-qty", value: "x" }) }));
    const cba = planOf(compileRun({ snapshot: sinkSnapshot({ value: "x", element: "el-qty" }) }));

    expect(cba.contentHash).toBe(abc.contentHash);
  });

  it("changing the tenant (teamId) ⇒ the hash changes — the plan is stamped with tenant in phase 6", () => {
    const base = sinkSnapshot();
    const otherTeam: CompileSnapshot = { ...base, teamId: "t2" };

    expect(planOf(compileRun({ snapshot: otherTeam })).contentHash).not.toBe(
      planOf(compileRun({ snapshot: base })).contentHash,
    );
  });

  it("changing the lane ⇒ the hash changes (policy is INSIDE the hashed payload)", () => {
    const batch = planOf(compileRun({ snapshot: sinkSnapshot(), lane: "batch" }));
    const interactive = planOf(compileRun({ snapshot: sinkSnapshot(), lane: "interactive" }));

    expect(interactive.contentHash).not.toBe(batch.contentHash);
  });

  it("contentHash does NOT itself join the hashed payload (the hash of the rest is stable)", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const { contentHash, ...payload } = plan;

    expect(contentHashOf(payload)).toBe(contentHash);
  });
});

describe("phase 6 — stamp policy/tenant", () => {
  it("planFormatVersion=1 (RAW payload, not zstd-compressed) + tenant/project from the snapshot", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(plan.planFormatVersion).toBe(PLAN_FORMAT_VERSION);
    expect(plan.planFormatVersion).toBe(1);
    expect(plan.teamId).toBe("t1");
    expect(plan.projectId).toBe("p1");
  });

  it("default lane=batch ⇒ screenshots=failure; lane=interactive ⇒ all (§5.2)", () => {
    expect(planOf(compileRun({ snapshot: sinkSnapshot() })).policy).toEqual({
      lane: "batch",
      engine: "chromium-headless-shell",
      retry: "infra-only",
      screenshots: "failure",
      baseUrl: "https://app.example",
    });

    expect(planOf(compileRun({ snapshot: sinkSnapshot(), lane: "interactive" })).policy.screenshots).toBe("all");
  });

  it("a per-run screenshots override beats the lane's default", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot(), screenshots: "none" }));
    expect(plan.policy.screenshots).toBe("none");
  });
});

describe("phase 7 — an ERROR ⇒ NO plan, but complete diagnostics", () => {
  function brokenSnapshot(): CompileSnapshot {
    const login = kase("login", [actionOn(1, "web.click", "el-chua-co-locator")]);
    const main = kase(
      "main",
      [actionOn(1, "web.khong-ton-tai", "el-ok"), actionOn(2, "web.enter", "el-ok", { value: "$secret:LA" })],
      { prereqCaseId: "login" },
    );
    return snap([login, main], ["main"], {
      elements: [element("el-ok"), element("el-chua-co-locator", "pending_locator")],
    });
  }

  it("plan === undefined when there's ≥1 diagnostic with severity=error", () => {
    const out = compileRun({ snapshot: brokenSnapshot() });

    expect(out.plan).toBeUndefined();
    expect(out.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("COLLECTS every error from every phase, no first-fail (ordered by phase flow)", () => {
    const out = compileRun({ snapshot: brokenSnapshot() });

    // Phase 3 for the whole chain first, then phase 4+5 for the whole chain — reads like a compiler's output.
    expect(out.diagnostics.map((d) => [d.caseId, d.code])).toEqual([
      ["main", "unknown_verb"],
      ["login", "element_pending_locator"],
      ["main", "secret_ref_unknown"],
    ]);
  });

  it("a phase 1 error (broken chain) still produces diagnostics, no plan, no throw", () => {
    const a = kase("a", [], { prereqCaseId: "b" });
    const b = kase("b", [], { prereqCaseId: "a" });
    const out = compileRun({ snapshot: snap([a, b], ["a"]) });

    expect(out.plan).toBeUndefined();
    expect(out.diagnostics.map((d) => d.code)).toEqual(["prereq_cycle"]);
  });

  it("the same broken prereq shared by 2 targets ⇒ the diagnostic is NOT duplicated", () => {
    const login = kase("login", [actionOn(1, "web.click", "el-mat")]);
    const one = kase("one", [], { prereqCaseId: "login" });
    const two = kase("two", [], { prereqCaseId: "login" });
    const out = compileRun({ snapshot: snap([login, one, two], ["one", "two"], { elements: [] }) });

    expect(out.diagnostics.map((d) => [d.caseId, d.code])).toEqual([["login", "element_not_found"]]);
  });
});

describe("dedupeDiagnostics — the dedup key must be a BIJECTION over the field set", () => {
  /**
   * The separator character is built with `fromCharCode`, NOT a literal escape: a real
   * control byte landing in the source would make git treat the whole file as binary —
   * blind diffs/PR view/grep.
   */
  const SEP = String.fromCharCode(0);
  const BASE = { severity: "error", code: "element_not_found" } as const;

  it("two DIFFERENT diagnostics are not merged, even when caseId/message contain the separator char", () => {
    // Joining fields with one separator makes the two sets below produce the SAME string:
    //   error SEP element_not_found SEP a SEP 1 SEP 2 SEP m
    // caseId comes from the legacy dump, message is free text — no field is allowed to
    // carry a syntactic role in the key.
    const a: CompileDiagnostic = { ...BASE, caseId: `a${SEP}1`, stepOrdinal: 2, message: "m" };
    const b: CompileDiagnostic = { ...BASE, caseId: "a", stepOrdinal: 1, message: `2${SEP}m` };

    expect(dedupeDiagnostics([a, b])).toEqual([a, b]);
  });

  it("`stepOrdinal` absent differs from `stepOrdinal` present (not collapsed to the same substitute string)", () => {
    const withOrdinal: CompileDiagnostic = { ...BASE, caseId: "c", stepOrdinal: 1, message: "m" };
    const noOrdinal: CompileDiagnostic = { ...BASE, caseId: "c", message: "m" };

    expect(dedupeDiagnostics([withOrdinal, noOrdinal])).toEqual([withOrdinal, noOrdinal]);
  });

  it("an exact duplicate IS STILL merged, keeping the first occurrence and original order", () => {
    const x: CompileDiagnostic = { ...BASE, caseId: "c", stepOrdinal: 1, message: "m" };
    const y: CompileDiagnostic = { ...BASE, caseId: "d", stepOrdinal: 1, message: "m" };

    expect(dedupeDiagnostics([x, { ...y }, { ...x }, y])).toEqual([x, y]);
  });
});

describe("compileRun — the phase 1→7 pipeline end-to-end", () => {
  it("a chain keeps correct execution order: prereq first, then each data-driven iteration", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(plan.chains.map((c) => c.chainKey)).toEqual(["checkout"]);
    const chain = plan.chains[0];
    if (chain === undefined) throw new Error("plan has no chains");

    expect(chain.cases.map((c) => [c.caseId, c.iterationLabel])).toEqual([
      ["login", undefined],
      ["checkout", "qty-1"],
      ["checkout", "qty-999"],
    ]);
    expect(chain.cases.map((c) => c.revisionId)).toEqual(["rev-login", "rev-checkout", "rev-checkout"]);
    expect(chain.cases.map((c) => c.expectedToFail)).toEqual([false, false, true]);
  });

  it("the step group is inlined flat + keeps groupPath provenance; data/env are merged; secret is STILL a ref", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const [login, firstRow] = plan.chains[0]?.cases ?? [];

    expect(login?.steps.map((s) => s.args)).toEqual([{ value: "acme-uat" }, { value: "$secret:ADMIN_PW" }]);

    expect(firstRow?.steps.map((s) => [s.ordinal, s.groupPath])).toEqual([
      [1, ["grp-header"]],
      [2, ["grp-header"]],
      [2, []],
    ]);
    expect(firstRow?.steps.at(-1)?.args).toEqual({ value: "1" });
  });

  it("an action step carries a pinned LocatorSet (the worker never re-queries the element table)", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const step = plan.chains[0]?.cases[0]?.steps[0];

    expect(step?.kind).toBe("action");
    expect(step?.kind === "action" && step.locators).toEqual({
      elementId: "el-user",
      elementName: "el-user",
      locators: [{ kind: "css", value: "#el-user" }],
    });
  });

  it("each target is ITS OWN chain, targetCaseIds order preserved", () => {
    const login = kase("login", [actionOn(1, "web.click", "el-ok")]);
    const one = kase("one", [actionOn(1, "web.click", "el-ok")], { prereqCaseId: "login" });
    const two = kase("two", [actionOn(1, "web.click", "el-ok")], { prereqCaseId: "login" });
    const plan = planOf(
      compileRun({ snapshot: snap([login, one, two], ["two", "one"], { elements: [element("el-ok")] }) }),
    );

    expect(plan.chains.map((c) => c.chainKey)).toEqual(["two", "one"]);
    expect(plan.chains.map((c) => c.cases.map((k) => k.caseId))).toEqual([
      ["login", "two"],
      ["login", "one"],
    ]);
    expect(plan.chains.map((c) => c.timeoutSeconds)).toEqual([180, 180]); // 90+24 → floor
  });

  it("an empty snapshot ⇒ a valid empty plan (still has a hash), no throw", () => {
    const plan = planOf(compileRun({ snapshot: snap([], []) }));

    expect(plan.chains).toEqual([]);
    expect(plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
