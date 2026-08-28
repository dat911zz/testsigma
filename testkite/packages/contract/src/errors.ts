/**
 * Error taxonomy — ONE predicate (`retryable === true`) gates every retry everywhere.
 *
 * Lives in a LEAF module rather than `index.ts`: `routes/*.ts` needs to throw NotFoundError,
 * and `index.ts` re-exports `routes/index.js` ⇒ putting it in the barrel would be an import
 * cycle (the same reason `enums.ts` was split out earlier in M1).
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;
  /** true = message may be returned verbatim to the tenant; false = mask with a generic sentence. */
  abstract readonly tenantVisible: boolean;

  /**
   * Extra machine-readable fields merged into the HTTP error payload alongside
   * code/message/requestId (e.g. ValidationFailedError's `issues`, the authoring
   * module's VersionConflictError `diff`). Override in a subclass that carries such
   * data; the shared handler (apps/core/src/http/errors.ts) spreads this instead of
   * duck-typing individual field names. Default is no extras.
   */
  publicExtras(): Readonly<Record<string, unknown>> {
    return {};
  }
}

/** Infra error that CAN be retried: browser_oom, context_crash, host_death, lease_expired, network. */
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

/** Infra error that is NOT retried (broken config, unknown plan version...). */
export class FatalInfraError extends AppError {
  readonly code = "fatal_infra";
  readonly httpStatus = 500;
  readonly retryable = false;
  readonly tenantVisible = false;
}

/**
 * An assertion failure IS A VERDICT, not a system error.
 * NEVER retry it — retrying a verdict poisons the result data.
 * The app hanging = failed(timeout): that's a product signal.
 */
export class AssertionFailure extends AppError {
  readonly code = "assertion_failure";
  readonly httpStatus = 200; // job COMPLETED with verdict=failed
  readonly retryable = false;
  readonly tenantVisible = true;
}

/** 400 — body/params/query failed zod validation. `issues` is a human-readable list. */
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
  override publicExtras(): Readonly<Record<string, unknown>> {
    return { issues: this.issues };
  }
}

/** 401 — no valid credential. NEVER say which part of the credential is wrong. */
export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED";
  readonly httpStatus = 401;
  readonly retryable = false;
  readonly tenantVisible = false;
}

/**
 * 403 — authenticated, but missing permission WITHIN one's own tenant.
 * A resource belonging to a DIFFERENT tenant never yields 403: it yields 404 (blueprint §3 L3).
 *
 * This class is the ANCHOR POINT for plan authoring: the authoring module's
 * `InsufficientScopeError` MUST extend from here, otherwise the generic error handler
 * maps it to 500.
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

/** 428 — mutation missing `If-Match` (optimistic concurrency, blueprint §4). */
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
