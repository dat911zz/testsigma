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

describe("HTTP error family", () => {
  it("every HTTP error is an AppError and carries the right status", () => {
    const cases: readonly [AppError, number, string][] = [
      [new ValidationFailedError("bad body", ["name: too short"]), 400, "VALIDATION_FAILED"],
      [new UnauthorizedError("missing credential"), 401, "UNAUTHORIZED"],
      [new ForbiddenError("missing permission"), 403, "FORBIDDEN"],
      [new NotFoundError("not found"), 404, "NOT_FOUND"],
      [new ConflictError("version conflict"), 409, "CONFLICT"],
      [new PreconditionRequiredError("missing If-Match"), 428, "PRECONDITION_REQUIRED"],
      [new TooManyRequestsError("quota exceeded"), 429, "RATE_LIMITED"],
    ];
    for (const [err, status, code] of cases) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.httpStatus).toBe(status);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(false);
    }
  });

  it("ValidationFailedError keeps the issue list", () => {
    expect(new ValidationFailedError("x", ["a", "b"]).issues).toEqual(["a", "b"]);
  });

  it("infra errors are NOT tenant-visible, API errors are", () => {
    expect(new RetryableInfraError("browser_oom", "x").tenantVisible).toBe(false);
    expect(new NotFoundError("x").tenantVisible).toBe(true);
  });

  it("AssertionFailure is still a 200 verdict and never retries", () => {
    const a = new AssertionFailure("expected true");
    expect(a.httpStatus).toBe(200);
    expect(a.retryable).toBe(false);
  });

  it("every HTTP-facing error's code is SCREAMING_SNAKE — the client-visible API taxonomy, locked", () => {
    // RetryableInfraError/FatalInfraError/AssertionFailure are excluded on purpose: they
    // carry job-verdict codes (browser_oom, fatal_infra, assertion_failure) from a
    // DIFFERENT taxonomy consumed by the runner/compiler retry policy, not the
    // client-facing API convention this test locks.
    const codes = [
      new ValidationFailedError("x").code,
      new UnauthorizedError("x").code,
      new ForbiddenError("x").code,
      new NotFoundError("x").code,
      new ConflictError("x").code,
      new PreconditionRequiredError("x").code,
      new TooManyRequestsError("x").code,
    ];
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
