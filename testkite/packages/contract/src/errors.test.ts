import { describe, expect, it } from "vitest";
import {
  AppError,
  AssertionFailure,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionRequiredError,
  RetryableInfraError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationFailedError,
} from "./errors.js";

describe("họ lỗi HTTP", () => {
  it("mọi lỗi HTTP đều là AppError và mang status đúng", () => {
    const cases: readonly [AppError, number, string][] = [
      [new ValidationFailedError("sai body", ["name: quá ngắn"]), 400, "VALIDATION_FAILED"],
      [new UnauthorizedError("thiếu credential"), 401, "UNAUTHORIZED"],
      [new ForbiddenError("thiếu quyền"), 403, "FORBIDDEN"],
      [new NotFoundError("không có"), 404, "NOT_FOUND"],
      [new ConflictError("đụng version"), 409, "CONFLICT"],
      [new PreconditionRequiredError("thiếu If-Match"), 428, "PRECONDITION_REQUIRED"],
      [new TooManyRequestsError("chạm quota"), 429, "RATE_LIMITED"],
    ];
    for (const [err, status, code] of cases) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.httpStatus).toBe(status);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(false);
    }
  });

  it("ValidationFailedError giữ danh sách issue", () => {
    expect(new ValidationFailedError("x", ["a", "b"]).issues).toEqual(["a", "b"]);
  });

  it("lỗi hạ tầng KHÔNG lộ ra tenant, lỗi API thì có", () => {
    expect(new RetryableInfraError("browser_oom", "x").tenantVisible).toBe(false);
    expect(new NotFoundError("x").tenantVisible).toBe(true);
  });

  it("AssertionFailure vẫn là verdict 200 và không bao giờ retry", () => {
    const a = new AssertionFailure("expected true");
    expect(a.httpStatus).toBe(200);
    expect(a.retryable).toBe(false);
  });
});
