import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileRun, PLAN_FORMAT_VERSION } from "./index.js";
import type { CompileOutput, RunPlan } from "./index.js";
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

/** Không dùng `!`: hoặc có plan, hoặc test hỏng ngay tại đây với thông điệp rõ. */
function planOf(out: CompileOutput): RunPlan {
  expect(out.diagnostics).toEqual([]);
  const { plan } = out;
  if (plan === undefined) throw new Error("compileRun không trả plan dù diagnostics rỗng");
  return plan;
}

// ---------------------------------------------------------------------------
// Snapshot "kitchen-sink nhỏ": prereq chain (login → checkout) + step group
// (grp-header inline 2 step) + data-driven (2 hàng). Đủ để một plan thật đi qua
// trọn phase 1→7 mà vẫn đọc được bằng mắt.
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

/** `qtyArgs` để test đổi 1 arg / đổi THỨ TỰ key mà không đổi gì khác. */
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

describe("phase 7 — canonicalize: cùng NỘI DUNG ⇒ cùng chuỗi, bất kể thứ tự key", () => {
  it("sort key ĐỆ QUY, không chỉ tầng ngoài", () => {
    const a = canonicalJson({ b: { z: 1, a: [{ y: 2, x: 3 }] }, a: "x" });
    const b = canonicalJson({ a: "x", b: { a: [{ x: 3, y: 2 }], z: 1 } });

    expect(a).toBe(b);
    expect(a).toBe('{"a":"x","b":{"a":[{"x":3,"y":2}],"z":1}}');
  });

  it("thứ tự MẢNG là ngữ nghĩa (thứ tự chạy) ⇒ KHÔNG được sort", () => {
    expect(canonicalJson(["b", "a"])).not.toBe(canonicalJson(["a", "b"]));
  });

  it("field optional vắng mặt ≡ field mang undefined (exactOptionalPropertyTypes)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("từ chối giá trị không phải JSON thay vì hash im lặng một payload sai", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/NaN|hữu hạn/i);
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it("chuỗi unicode/dấu tiếng Việt được escape ổn định", () => {
    expect(canonicalJson({ "Họ Tên": "Quản trị" })).toBe('{"Họ Tên":"Quản trị"}');
  });
});

describe("phase 7 — contentHash = SHA-256 của payload canonical", () => {
  it("đúng là SHA-256 hex của canonicalJson, không phải digest tự chế", () => {
    const value = { b: 1, a: [2, 3] };
    const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

    expect(contentHashOf(value)).toBe(expected);
    expect(contentHashOf(value)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("phase 6 — timeout chain = clamp(90 + 12×steps, 180..900)", () => {
  it("sàn 180s cho chain ngắn", () => {
    expect(chainTimeoutSeconds(0)).toBe(MIN_CHAIN_TIMEOUT_SECONDS);
    expect(chainTimeoutSeconds(7)).toBe(180); // 90+84=174 → sàn
  });

  it("vùng tuyến tính giữa hai trần", () => {
    expect(chainTimeoutSeconds(8)).toBe(186);
    expect(chainTimeoutSeconds(30)).toBe(450);
    expect(chainTimeoutSeconds(67)).toBe(894);
  });

  it("trần 900s cho chain khổng lồ", () => {
    expect(chainTimeoutSeconds(68)).toBe(MAX_CHAIN_TIMEOUT_SECONDS); // 90+816=906 → trần
    expect(chainTimeoutSeconds(10_000)).toBe(900);
  });

  it("countSteps đếm ĐỆ QUY qua children và cộng dồn mọi iteration của chain", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const chain = plan.chains[0];
    if (chain === undefined) throw new Error("plan không có chain nào");

    // login 2 step + checkout ×2 hàng × (2 step group đã inline + 1 step) = 2 + 6 = 8
    expect(countSteps(chain.cases)).toBe(8);
    expect(chain.stepCount).toBe(8);
    expect(chain.timeoutSeconds).toBe(chainTimeoutSeconds(8));
    expect(chain.timeoutSeconds).toBe(186);
  });
});

describe("phase 7 — freeze: hash ổn định theo NỘI DUNG", () => {
  it("cùng input ⇒ cùng contentHash qua 2 lần gọi (không timestamp, không random)", () => {
    const first = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const second = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("đổi ĐÚNG 1 arg ⇒ hash đổi", () => {
    const base = planOf(compileRun({ snapshot: sinkSnapshot({ value: "$data:qty" }) }));
    const changed = planOf(compileRun({ snapshot: sinkSnapshot({ value: "sửa-tay" }) }));

    expect(changed.contentHash).not.toBe(base.contentHash);
  });

  it("đổi THỨ TỰ key trong args ⇒ hash KHÔNG đổi", () => {
    const abc = planOf(compileRun({ snapshot: sinkSnapshot({ element: "el-qty", value: "x" }) }));
    const cba = planOf(compileRun({ snapshot: sinkSnapshot({ value: "x", element: "el-qty" }) }));

    expect(cba.contentHash).toBe(abc.contentHash);
  });

  it("đổi tenant (teamId) ⇒ hash đổi — plan bị đóng dấu tenant ở phase 6", () => {
    const base = sinkSnapshot();
    const otherTeam: CompileSnapshot = { ...base, teamId: "t2" };

    expect(planOf(compileRun({ snapshot: otherTeam })).contentHash).not.toBe(
      planOf(compileRun({ snapshot: base })).contentHash,
    );
  });

  it("đổi lane ⇒ hash đổi (policy nằm TRONG payload bị hash)", () => {
    const batch = planOf(compileRun({ snapshot: sinkSnapshot(), lane: "batch" }));
    const interactive = planOf(compileRun({ snapshot: sinkSnapshot(), lane: "interactive" }));

    expect(interactive.contentHash).not.toBe(batch.contentHash);
  });

  it("contentHash KHÔNG tự tham gia payload bị hash (hash của phần còn lại là ổn định)", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const { contentHash, ...payload } = plan;

    expect(contentHashOf(payload)).toBe(contentHash);
  });
});

describe("phase 6 — stamp policy/tenant", () => {
  it("planFormatVersion=1 (payload THÔ, chưa nén zstd) + tenant/project từ snapshot", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(plan.planFormatVersion).toBe(PLAN_FORMAT_VERSION);
    expect(plan.planFormatVersion).toBe(1);
    expect(plan.teamId).toBe("t1");
    expect(plan.projectId).toBe("p1");
  });

  it("mặc định lane=batch ⇒ screenshots=failure; lane=interactive ⇒ all (§5.2)", () => {
    expect(planOf(compileRun({ snapshot: sinkSnapshot() })).policy).toEqual({
      lane: "batch",
      engine: "chromium-headless-shell",
      retry: "infra-only",
      screenshots: "failure",
      baseUrl: "https://app.example",
    });

    expect(planOf(compileRun({ snapshot: sinkSnapshot(), lane: "interactive" })).policy.screenshots).toBe("all");
  });

  it("override screenshots per-run thắng mặc định của lane", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot(), screenshots: "none" }));
    expect(plan.policy.screenshots).toBe("none");
  });
});

describe("phase 7 — có ERROR ⇒ KHÔNG có plan, nhưng diagnostics đầy đủ", () => {
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

  it("plan === undefined khi có ≥1 diagnostic severity=error", () => {
    const out = compileRun({ snapshot: brokenSnapshot() });

    expect(out.plan).toBeUndefined();
    expect(out.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("GOM đủ mọi lỗi của mọi phase, không first-fail (xếp theo dòng chảy phase)", () => {
    const out = compileRun({ snapshot: brokenSnapshot() });

    // phase 3 của cả chain trước, rồi phase 4+5 của cả chain — đọc như output compiler.
    expect(out.diagnostics.map((d) => [d.caseId, d.code])).toEqual([
      ["main", "unknown_verb"],
      ["login", "element_pending_locator"],
      ["main", "secret_ref_unknown"],
    ]);
  });

  it("lỗi phase 1 (chain hỏng) vẫn ra diagnostics, không plan, không ném", () => {
    const a = kase("a", [], { prereqCaseId: "b" });
    const b = kase("b", [], { prereqCaseId: "a" });
    const out = compileRun({ snapshot: snap([a, b], ["a"]) });

    expect(out.plan).toBeUndefined();
    expect(out.diagnostics.map((d) => d.code)).toEqual(["prereq_cycle"]);
  });

  it("cùng một prereq hỏng dùng chung bởi 2 target ⇒ diagnostic KHÔNG nhân bản", () => {
    const login = kase("login", [actionOn(1, "web.click", "el-mat")]);
    const one = kase("one", [], { prereqCaseId: "login" });
    const two = kase("two", [], { prereqCaseId: "login" });
    const out = compileRun({ snapshot: snap([login, one, two], ["one", "two"], { elements: [] }) });

    expect(out.diagnostics.map((d) => [d.caseId, d.code])).toEqual([["login", "element_not_found"]]);
  });
});

describe("compileRun — pipeline phase 1→7 end-to-end", () => {
  it("chain giữ đúng thứ tự thực thi: prereq trước, rồi từng iteration data-driven", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));

    expect(plan.chains.map((c) => c.chainKey)).toEqual(["checkout"]);
    const chain = plan.chains[0];
    if (chain === undefined) throw new Error("plan không có chain nào");

    expect(chain.cases.map((c) => [c.caseId, c.iterationLabel])).toEqual([
      ["login", undefined],
      ["checkout", "qty-1"],
      ["checkout", "qty-999"],
    ]);
    expect(chain.cases.map((c) => c.revisionId)).toEqual(["rev-login", "rev-checkout", "rev-checkout"]);
    expect(chain.cases.map((c) => c.expectedToFail)).toEqual([false, false, true]);
  });

  it("step group đã inline phẳng + giữ provenance groupPath; data/env đã merge; secret VẪN là ref", () => {
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

  it("step action mang LocatorSet đã ghim (worker không tra lại bảng element)", () => {
    const plan = planOf(compileRun({ snapshot: sinkSnapshot() }));
    const step = plan.chains[0]?.cases[0]?.steps[0];

    expect(step?.kind).toBe("action");
    expect(step?.kind === "action" && step.locators).toEqual({
      elementId: "el-user",
      elementName: "el-user",
      locators: [{ kind: "css", value: "#el-user" }],
    });
  });

  it("mỗi target là MỘT chain riêng, giữ thứ tự targetCaseIds", () => {
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
    expect(plan.chains.map((c) => c.timeoutSeconds)).toEqual([180, 180]); // 90+24 → sàn
  });

  it("snapshot rỗng ⇒ plan rỗng hợp lệ (vẫn có hash), không ném", () => {
    const plan = planOf(compileRun({ snapshot: snap([], []) }));

    expect(plan.chains).toEqual([]);
    expect(plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
