/**
 * Taxonomy lỗi — MỘT vị từ (`retryable === true`) gate mọi retry ở mọi nơi.
 *
 * Sống ở module LÁ chứ không `index.ts`: `routes/*.ts` cần ném NotFoundError,
 * mà `index.ts` lại re-export `routes/index.js` ⇒ để ở barrel là vòng import
 * (đúng lý do `enums.ts` đã tách ra trước đó ở M1).
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;
  /** true = message được phép trả nguyên văn cho tenant; false = che bằng câu chung. */
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

/** 400 — body/params/query không qua zod. `issues` là danh sách người dùng đọc được. */
export class ValidationFailedError extends AppError {
  readonly code = "VALIDATION_FAILED";
  readonly httpStatus = 400;
  readonly retryable = false;
  readonly tenantVisible = true;
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** 401 — không có credential hợp lệ. KHÔNG BAO GIỜ nói credential sai ở chỗ nào. */
export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED";
  readonly httpStatus = 401;
  readonly retryable = false;
  readonly tenantVisible = false;
}

/**
 * 403 — đã xác thực, thiếu quyền TRONG CHÍNH tenant của mình.
 * Tài nguyên của tenant KHÁC không bao giờ ra 403: nó ra 404 (blueprint §3 L3).
 *
 * Lớp này là ĐIỂM NEO cho plan authoring: `InsufficientScopeError` của module
 * authoring PHẢI kế thừa từ đây, nếu không error handler chung map nó thành 500.
 */
export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;
  readonly retryable = false;
  readonly tenantVisible = true;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  readonly retryable = false;
  readonly tenantVisible = true;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly tenantVisible = true;
}

/** 428 — mutation thiếu `If-Match` (optimistic concurrency, blueprint §4). */
export class PreconditionRequiredError extends AppError {
  readonly code = "PRECONDITION_REQUIRED";
  readonly httpStatus = 428;
  readonly retryable = false;
  readonly tenantVisible = true;
}

export class TooManyRequestsError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
  readonly retryable = false;
  readonly tenantVisible = true;
}
