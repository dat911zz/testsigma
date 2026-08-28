/**
 * Authoring error taxonomy. Each error carries its own httpStatus + code so a route
 * only has to map it, never guess.
 *
 * They ALL extend `AppError` from @testkite/contract (directly, or via a concrete
 * subclass): the shared HTTP handler recognises errors through `instanceof AppError`,
 * so plain `Error` subclasses would fall through to 500. `CaseNotFoundError` extends
 * the contract's `NotFoundError` (code `NOT_FOUND`) on purpose: a cross-tenant probe
 * must get the EXACT same body as a genuinely missing id (blueprint §3 L3 — never a
 * distinct code, which would itself confirm the id exists).
 */
import { AppError, NotFoundError } from "@testkite/contract";
import type { ThreeWayDiffDto } from "@testkite/contract";

/**
 * 404 for every "not found", including an id that exists but belongs to another
 * tenant. Inherits code `NOT_FOUND` from NotFoundError so it is indistinguishable
 * from a truly absent id (blueprint §3 L3: cross-tenant is 404, never 403).
 */
export class CaseNotFoundError extends NotFoundError {
  constructor(caseId: string) {
    super(`Case not found: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/** 428 Precondition Required — a mutation arrived without a valid If-Match. */
export class IfMatchRequiredError extends AppError {
  readonly code = "IF_MATCH_REQUIRED";
  readonly httpStatus = 428;
  readonly retryable = false;
  readonly tenantVisible = true;
  constructor(reason: string) {
    super(`An If-Match header carrying the case version is required: ${reason}`);
    this.name = "IfMatchRequiredError";
  }
}

/** 409 — the client's version differs from the server's. Carries the 3-way diff. */
export class VersionConflictError extends AppError {
  readonly code = "VERSION_CONFLICT";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly tenantVisible = true;
  readonly diff: ThreeWayDiffDto;
  constructor(diff: ThreeWayDiffDto) {
    super(`Case changed: you are based on version ${diff.baseVersion}, the server is at ${diff.currentVersion}`);
    this.name = "VersionConflictError";
    this.diff = diff;
  }
  override publicExtras(): Readonly<Record<string, unknown>> {
    return { diff: this.diff };
  }
}

/** 409 — the operation is invalid for the case's current state (e.g. submit a ready case). */
export class CaseStateError extends AppError {
  readonly code = "INVALID_CASE_STATE";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly tenantVisible = true;
  constructor(message: string) {
    super(message);
    this.name = "CaseStateError";
  }
}

/**
 * 403 — four-eyes: the last editor cannot promote their own case. Deliberately a 403,
 * not a 404: this is a policy violation WITHIN the same tenant — the actor has already
 * seen the case, so nothing leaks; a 404 here would lie that the case vanished.
 */
export class FourEyesViolationError extends AppError {
  readonly code = "FOUR_EYES_SELF_PROMOTE";
  readonly httpStatus = 403;
  readonly retryable = false;
  readonly tenantVisible = true;
  constructor(caseId: string) {
    super(
      `You are the last editor of case ${caseId} and cannot promote it yourself. ` +
        `A second person must promote it, or the team must enable teams.allow_self_promote.`,
    );
    this.name = "FourEyesViolationError";
  }
}
