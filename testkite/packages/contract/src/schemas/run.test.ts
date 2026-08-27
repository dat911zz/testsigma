import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES, compileDiagnosticSchema, runSchema } from "./run.js";

describe("COMPILE_ERROR_CODES", () => {
  it("giữ đủ 12 code của compiler M1", () => {
    expect(COMPILE_ERROR_CODES).toHaveLength(12);
    expect(COMPILE_ERROR_CODES).toContain("prereq_cycle");
    expect(COMPILE_ERROR_CODES).toContain("secret_ref_unknown");
  });

  it("thứ tự = dòng chảy phase 1→5, prereq_cycle đứng đầu", () => {
    expect(COMPILE_ERROR_CODES[0]).toBe("prereq_cycle");
  });
});

describe("compileDiagnosticSchema", () => {
  it("nhận diagnostic có stepOrdinal", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "verb_args_invalid",
      caseId: "checkout",
      stepOrdinal: 3,
      message: "thiếu param 'value'",
    });
    expect(r.success).toBe(true);
  });

  it("nhận diagnostic không stepOrdinal (lỗi cấp case)", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "prereq_cycle",
      caseId: "a",
      message: "cycle a→b→a",
    });
    expect(r.success).toBe(true);
  });

  it("từ chối code ngoài danh mục", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "kaboom",
      caseId: "a",
      message: "x",
    });
    expect(r.success).toBe(false);
  });
});

/**
 * Barrel `src/index.ts` re-export `./schemas/index.js` (task A5). Nếu một file schema
 * import NGƯỢC lên barrel đó, đồ thị module thành vòng: nạp barrel ⇒ nạp schemas ⇒ nạp
 * file schema ⇒ đọc hằng của barrel khi thân barrel CHƯA chạy ⇒ `ReferenceError: Cannot
 * access 'RUN_VERDICTS' before initialization` dưới ESM thật (tsx/node).
 *
 * Vitest KHÔNG bắt được lỗi này — SSR transform của vite-node xếp thứ tự khác nên vẫn
 * xanh. Vì vậy luật phải được canh tĩnh: schema chỉ được import module LÁ
 * (`../enums.js`), không bao giờ import barrel.
 */
describe("chống vòng import qua barrel", () => {
  const schemasDir = dirname(fileURLToPath(import.meta.url));

  it("không file schema nào import ngược `../index.js`", () => {
    const offenders = readdirSync(schemasDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts")
      .filter((f) => /from\s+"\.\.\/index\.js"/.test(readFileSync(join(schemasDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("runSchema", () => {
  const run = {
    id: "run-001",
    teamId: "team-acme",
    projectId: "proj-web-checkout",
    lane: "batch",
    status: "succeeded",
    verdict: "passed",
    planContentHash: "a".repeat(64),
    diagnostics: [],
  };

  it("nhận run passed", () => {
    expect(runSchema.parse(run).verdict).toBe("passed");
  });

  it("nhận run compile_error kèm diagnostics và KHÔNG có planContentHash", () => {
    const { planContentHash: _drop, ...noPlan } = run;
    const r = runSchema.safeParse({
      ...noPlan,
      status: "failed",
      verdict: "compile_error",
      diagnostics: [{ severity: "error", code: "unknown_verb", caseId: "a", message: "web.teleport" }],
    });
    expect(r.success).toBe(true);
  });

  it("từ chối planContentHash không phải sha256 hex 64 ký tự", () => {
    expect(runSchema.safeParse({ ...run, planContentHash: "deadbeef" }).success).toBe(false);
  });

  it("từ chối verdict lạ", () => {
    expect(runSchema.safeParse({ ...run, verdict: "flaky" }).success).toBe(false);
  });

  it("từ chối status lạ", () => {
    expect(runSchema.safeParse({ ...run, status: "queued" }).success).toBe(false);
  });
});
