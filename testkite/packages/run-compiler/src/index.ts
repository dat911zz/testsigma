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
 *     schedule/CI chạy bản 'ready': QA sửa giữa đêm không đổi gì đang bay)
 *  2. nở cấu trúc: step group inline ≤ 5 (local | subscribed frozen snapshot),
 *     if/loop → cây block, data-driven fan-out + expected_to_fail
 *  3. bind verb → op registry (GOM MỌI LỖI, không first-fail)
 *  4. element → LocatorSet (pending_locator ⇒ diagnostic riêng)
 *  5. merge data/env; secret CHỈ là $secretRef — không bao giờ giá trị
 *  6. stamp policy/tenant (timeout, retry=infra-only, screenshots theo lane, engine)
 *  7. freeze: canonicalize → SHA-256 → zstd → planFormatVersion
 */

export const PLAN_FORMAT_VERSION = 1;

export type CompileErrorCode =
  | "prereq_cycle"
  | "prereq_depth_exceeded"
  | "prereq_missing"
  | "step_group_depth_exceeded"
  | "unknown_verb"
  | "verb_args_invalid"
  | "element_pending_locator"
  | "element_not_found"
  | "secret_ref_unknown"
  | "while_without_max_iterations"
  | "data_profile_empty";

export interface CompileDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: CompileErrorCode;
  readonly caseId: string;
  readonly stepOrdinal?: number;
  readonly message: string;
}

export interface RunPlan {
  readonly planFormatVersion: typeof PLAN_FORMAT_VERSION;
  readonly contentHash: string; // SHA-256 của payload canonical
  readonly teamId: string;
  readonly projectId: string;
  /** Mỗi chain = prereq login + các case phụ thuộc — ĐƠN VỊ JOB của fleet. */
  readonly chains: readonly ChainPlan[];
}

export interface ChainPlan {
  readonly chainKey: string;
  readonly cases: readonly CasePlan[];
  readonly timeoutSeconds: number; // clamp(90 + 12×steps, 180..900)
}

export interface CasePlan {
  readonly caseId: string;
  readonly revisionId: string; // đã ghim — bất biến
  readonly iterationLabel?: string; // data-driven
  readonly expectedToFail: boolean;
  readonly steps: readonly StepPlan[];
}

export interface StepPlan {
  readonly ordinal: number;
  readonly opKey: string; // đã validate với @testkite/verb-kit
  readonly args: Record<string, string>; // secret = "$secretRef:<name>"
  readonly renderedSentence: string; // câu NLP hiển thị cho QA trong kết quả
}

export interface CompileInput {
  readonly teamId: string;
  readonly projectId: string;
  // TODO(M1): snapshot authoring đã fetch sẵn (cases, steps, elements, data, env)
  // — compiler KHÔNG tự query DB; orchestration nạp input để giữ hàm pure.
}

export interface CompileOutput {
  readonly plan?: RunPlan; // undefined khi có ít nhất 1 diagnostic severity=error
  readonly diagnostics: readonly CompileDiagnostic[];
}

export function compileRun(_input: CompileInput): CompileOutput {
  // TODO(M1): phase 1–7 theo blueprint; golden test trước khi viết orchestration.
  throw new Error("TODO(M1): compiler core — hạng mục xây ĐẦU TIÊN của lộ trình");
}
