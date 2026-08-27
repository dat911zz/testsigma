/**
 * @testkite/contract — zod là NGUỒN hợp đồng duy nhất.
 * OpenAPI 3.1 được SINH RA từ đây và commit; CI fail khi drift; oasdiff chặn breaking change.
 */

// ---------------------------------------------------------------------------
// Verdicts (docs/SYSTEM_DESIGN.md §2, §4) — định nghĩa ở `./enums.js` (module lá),
// tái xuất ở đây để bề mặt facade không đổi. Schema import thẳng module lá, không
// qua barrel này: barrel re-export schemas nên đọc ngược lên đây là vòng import.
// ---------------------------------------------------------------------------

export * from "./enums.js";
export * from "./schemas/index.js";

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
