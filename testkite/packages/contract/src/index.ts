/**
 * @testkite/contract — zod là NGUỒN hợp đồng duy nhất.
 * OpenAPI 3.1 được SINH RA từ đây và commit; CI fail khi drift; oasdiff chặn breaking change.
 */

// ---------------------------------------------------------------------------
// Verdicts (docs/SYSTEM_DESIGN.md §2, §4)
// ---------------------------------------------------------------------------

/** Verdict của một run — compile_error/blocked xảy ra TRƯỚC khi bất kỳ browser nào khởi động. */
export const RUN_VERDICTS = [
  "passed",
  "failed",
  "compile_error",
  "blocked", // cổng health môi trường (phase 7.5) chặn
  "aborted_early", // phanh mass-failure: 25 chain đầu fail cùng signature
  "cancelled",
] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Trạng thái job (job_runs — queue of record trong MySQL). */
export const JOB_STATUSES = [
  "pending",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rejected_quota",
  "unknown_after_restore", // quarantine bắt buộc sau restore DB, TRƯỚC khi reaper chạy
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ["chain", "element_verify", "capture_session", "env_probe"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const LANES = ["interactive", "batch"] as const;
export type Lane = (typeof LANES)[number];

// ---------------------------------------------------------------------------
// Error taxonomy — MỘT vị từ (`retryable === true`) gate mọi retry ở mọi nơi.
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;
  abstract readonly tenantVisible: boolean;
}

/** Lỗi hạ tầng CÓ THỂ retry: browser_oom, context_crash, host_death, lease_expired, network. */
export class RetryableInfraError extends AppError {
  readonly code: string;
  readonly httpStatus = 503;
  readonly retryable = true;
  readonly tenantVisible = false;
  constructor(code: "browser_oom" | "context_crash" | "host_death" | "lease_expired" | "network", message: string) {
    super(message);
    this.code = code;
  }
}

/** Lỗi hạ tầng KHÔNG retry (cấu hình hỏng, plan version lạ...). */
export class FatalInfraError extends AppError {
  readonly code = "fatal_infra";
  readonly httpStatus = 500;
  readonly retryable = false;
  readonly tenantVisible = false;
}

/**
 * Assertion fail LÀ MỘT VERDICT, không phải một lỗi hệ thống.
 * KHÔNG BAO GIỜ retry — retry một verdict là đầu độc dữ liệu kết quả.
 * App treo = failed(timeout): đó là tín hiệu sản phẩm.
 */
export class AssertionFailure extends AppError {
  readonly code = "assertion_failure";
  readonly httpStatus = 200; // job HOÀN THÀNH với verdict=failed
  readonly retryable = false;
  readonly tenantVisible = true;
}
