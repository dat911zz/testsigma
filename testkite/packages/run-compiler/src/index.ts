/**
 * @testkite/run-compiler — TRÁI TIM của TestKite (docs/SYSTEM_DESIGN.md §4).
 *
 * Pure function: (scope, snapshot dữ liệu authoring) → RunPlan BẤT BIẾN, content-hashed.
 * - Worker KHÔNG BAO GIỜ đọc bảng authoring — chỉ nhận plan đã freeze.
 * - Mọi lỗi (verb chưa port, element pending_locator, chu trình prereq) bắt TRƯỚC
 *   khi bất kỳ browser nào khởi động → verdict=compile_error, hoàn quota.
 * - Golden test (T1): cùng input ⇒ cùng content_hash, mọi CompileErrorCode có fixture âm.
 *
 * 9 phase (0 và 7.5–9 nằm ở orchestration; package này thuần 1→7):
 *  1. resolve chuỗi prereq (cycle check, depth ≤ 5, GHIM REVISION —
 *     schedule/CI chạy bản 'ready': QA sửa giữa đêm không đổi gì đang bay)  → phase1-chains.ts
 *  2. nở cấu trúc: step group inline ≤ 5 (local | subscribed frozen snapshot),
 *     if/loop → cây block, data-driven fan-out + expected_to_fail            → phase2-expand.ts
 *  3. bind verb → op registry (GOM MỌI LỖI, không first-fail)                → phase3-bind.ts
 *  4. element → LocatorSet (pending_locator ⇒ diagnostic riêng)              → phase45-resolve.ts
 *  5. merge data/env; secret CHỈ là $secretRef — không bao giờ giá trị       → phase45-resolve.ts
 *  6. stamp policy/tenant (timeout, retry=infra-only, screenshots theo lane) → phase67-freeze.ts
 *  7. freeze: canonicalize → SHA-256 → planFormatVersion (zstd: TODO M2)     → phase67-freeze.ts
 */
import { resolveChains } from "./phase1-chains.js";
import { expandCases } from "./phase2-expand.js";
import { bindCases } from "./phase3-bind.js";
import { resolveCases } from "./phase45-resolve.js";
import { freezePlan } from "./phase67-freeze.js";
import type { FrozenChain, RunLane, ScreenshotPolicy } from "./phase67-freeze.js";
import type { CompileSnapshot } from "./snapshot.js";

/**
 * Danh mục lỗi compile — DỮ LIỆU, không chỉ là type: golden suite phải liệt kê được mọi code
 * lúc CHẠY để chứng minh "mỗi code có ≥1 fixture âm". Union được DẪN XUẤT từ mảng này, nên
 * thêm code mới mà quên fixture là gãy test ngay, không phải một khoảng trống im lặng.
 * Thứ tự = dòng chảy phase 1→5 (đọc như output của compiler).
 */
export const COMPILE_ERROR_CODES = [
  "prereq_cycle",
  "prereq_depth_exceeded",
  "prereq_missing",
  "step_group_depth_exceeded",
  "step_group_missing",
  "unknown_verb",
  "verb_args_invalid",
  "element_pending_locator",
  "element_not_found",
  "secret_ref_unknown",
  "while_without_max_iterations",
  "data_profile_empty",
] as const;

export type CompileErrorCode = (typeof COMPILE_ERROR_CODES)[number];

export interface CompileDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: CompileErrorCode;
  readonly caseId: string;
  readonly stepOrdinal?: number;
  readonly message: string;
}

// Bề mặt công khai của plan — kiểu do phase sinh ra nó sở hữu, index chỉ tái xuất.
export { PLAN_FORMAT_VERSION, canonicalJson, chainTimeoutSeconds, contentHashOf, countSteps, freezePlan } from "./phase67-freeze.js";
export type {
  CasePlan,
  ChainPlan,
  RunLane,
  RunPlan,
  RunPolicy,
  ScreenshotPolicy,
  StepPlan,
} from "./phase67-freeze.js";
export type { LocatorSet, ResolvedActionStep, ResolvedBlockStep } from "./phase45-resolve.js";
export type * from "./snapshot.js";

import type { RunPlan } from "./phase67-freeze.js";

export interface CompileInput {
  /** Snapshot authoring đã fetch sẵn — compiler KHÔNG tự query DB, đó là điều giữ hàm pure. */
  readonly snapshot: CompileSnapshot;
  /** Vắng mặt ⇒ "batch" (đường chạy đêm/CI). */
  readonly lane?: RunLane;
  /** Override per-run; vắng mặt ⇒ mặc định theo lane (§5.2). */
  readonly screenshots?: ScreenshotPolicy;
}

export interface CompileOutput {
  readonly plan?: RunPlan; // undefined khi có ít nhất 1 diagnostic severity=error
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Chạy trọn phase 1→7.
 *
 * Hai luật chi phối hình dạng của hàm này:
 *  - GOM MỌI LỖI, không first-fail: mọi phase đều chạy đến hết trên mọi chain, diagnostic
 *    được cộng dồn. Tác giả sửa MỘT lượt, không phải compile lại 6 lần để lộ 6 lỗi.
 *  - Có ≥1 `severity: "error"` ⇒ KHÔNG sinh plan. Plan nửa vời còn nguy hiểm hơn không có
 *    plan: nó chạy được, tốn tiền browser, rồi fail vì thứ đã biết từ compile-time.
 *
 * Diagnostic xếp theo DÒNG CHẢY PHASE (mọi lỗi phase 3 của chain, rồi mọi lỗi phase 4+5),
 * không theo case — đọc như output của một compiler, không như một danh sách lỗi trộn lẫn.
 */
export function compileRun(input: CompileInput): CompileOutput {
  const { snapshot } = input;
  const diagnostics: CompileDiagnostic[] = [];
  const chains: FrozenChain[] = [];

  const chainResolution = resolveChains(snapshot); // phase 1
  diagnostics.push(...chainResolution.diagnostics);

  for (const chain of chainResolution.chains) {
    const expansion = expandCases(snapshot, chain.caseIds); // phase 2
    diagnostics.push(...expansion.diagnostics);

    const binding = bindCases(expansion.cases); // phase 3
    diagnostics.push(...binding.diagnostics);

    const resolution = resolveCases(binding.cases, snapshot); // phase 4+5
    diagnostics.push(...resolution.diagnostics);

    chains.push({ chainKey: chain.chainKey, cases: resolution.cases });
  }

  const unique = dedupeDiagnostics(diagnostics);
  if (unique.some((d) => d.severity === "error")) return { diagnostics: unique };

  return {
    plan: freezePlan({
      // phase 6+7
      teamId: snapshot.teamId,
      projectId: snapshot.projectId,
      baseUrl: snapshot.env.baseUrl,
      lane: input.lane ?? "batch",
      chains,
      ...(input.screenshots === undefined ? {} : { screenshots: input.screenshots }),
    }),
    diagnostics: unique,
  };
}

/**
 * Chain là đơn vị CÔ LẬP: một prereq `login` dùng chung bởi 5 target được nở 5 lần, nên một
 * element hỏng trong `login` sinh 5 diagnostic GIỐNG HỆT. Tác giả cần biết `login` hỏng đúng
 * MỘT lần — bản sao y nguyên không mang thêm thông tin nào.
 *
 * Khoá gộp phải là SONG ÁNH với bộ field. Nối field bằng một dấu phân cách thì không: `caseId`
 * đến từ dump hệ cũ và `message` là free-text, nên cả hai đều có thể chứa đúng ký tự đang giữ
 * vai trò cú pháp — hai lỗi khác nhau ra cùng một khoá và một lỗi thật biến mất khỏi output.
 * `JSON.stringify` của mảng field thì không mơ hồ: mọi ký tự trong chuỗi đều được escape, biên
 * giữa các phần tử là cấu trúc chứ không phải quy ước.
 */
export function dedupeDiagnostics(all: readonly CompileDiagnostic[]): readonly CompileDiagnostic[] {
  const seen = new Set<string>();
  const out: CompileDiagnostic[] = [];

  for (const d of all) {
    const key = JSON.stringify([d.severity, d.code, d.caseId, d.stepOrdinal ?? null, d.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  return out;
}
