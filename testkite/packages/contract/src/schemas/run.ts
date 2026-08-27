/**
 * DTO run + danh mục lỗi compile.
 *
 * `COMPILE_ERROR_CODES` SỐNG Ở ĐÂY chứ không ở run-compiler: contract không được
 * import run-compiler (ngược DAG), mà `runSchema` cần danh mục này. run-compiler
 * re-export lại — nó vốn phụ thuộc contract, nên chiều này là chiều xuôi duy nhất
 * giữ được MỘT danh sách.
 */
import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES, LANES, RUN_VERDICTS } from "../enums.js";

export const runVerdictSchema = z.enum(RUN_VERDICTS);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const jobKindSchema = z.enum(JOB_KINDS);
export const laneSchema = z.enum(LANES);

/**
 * DỮ LIỆU, không chỉ là type: golden suite của compiler duyệt mảng này lúc CHẠY
 * để chứng minh "mỗi code có ≥1 fixture âm". Thứ tự = dòng chảy phase 1→5.
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

export const compileErrorCodeSchema = z.enum(COMPILE_ERROR_CODES);

export const compileDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: compileErrorCodeSchema,
  caseId: z.string().min(1),
  /** Vắng mặt = lỗi cấp case (prereq cycle...), không phải cấp step. */
  stepOrdinal: z.number().int().positive().optional(),
  message: z.string().min(1),
});

/** SHA-256 hex thường — khớp `contentHashOf` của phase 7. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const runSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  lane: laneSchema,
  status: jobStatusSchema,
  verdict: runVerdictSchema,
  /** Vắng mặt khi verdict=compile_error: không có plan thì không có hash. */
  planContentHash: contentHashSchema.optional(),
  diagnostics: z.array(compileDiagnosticSchema),
});

export interface CompileDiagnosticDto {
  severity: "error" | "warning";
  code: CompileErrorCode;
  caseId: string;
  stepOrdinal?: number | undefined;
  message: string;
}

export interface RunDto {
  id: string;
  teamId: string;
  projectId: string;
  lane: (typeof LANES)[number];
  status: (typeof JOB_STATUSES)[number];
  verdict: (typeof RUN_VERDICTS)[number];
  planContentHash?: string | undefined;
  diagnostics: CompileDiagnosticDto[];
}
