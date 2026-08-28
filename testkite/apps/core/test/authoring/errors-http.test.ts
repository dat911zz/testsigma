/**
 * The five authoring errors must map to their intended HTTP status through the SHARED
 * error handler (apps/core/src/http/errors.ts), which recognises errors via
 * `instanceof AppError`. Before they extended AppError they fell through to 500 when
 * wired into the real app; this test locks the mapping so that regression cannot
 * return silently. (Reviewer warning B1.)
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@testkite/contract";
import type { ThreeWayDiffDto } from "@testkite/contract";
import { toErrorPayload } from "../../src/http/errors.js";
import {
  CaseNotFoundError,
  CaseStateError,
  FourEyesViolationError,
  IfMatchRequiredError,
  VersionConflictError,
} from "../../src/modules/authoring/errors.js";

const diff: ThreeWayDiffDto = {
  baseVersion: 1,
  baseRevisionId: "r1",
  currentVersion: 2,
  currentRevisionId: "r2",
  mine: [],
  theirs: [],
  conflicts: [],
};

describe("authoring errors map to HTTP through the shared handler", () => {
  const cases: { error: Error; status: number; code: string }[] = [
    { error: new CaseNotFoundError("c1"), status: 404, code: "NOT_FOUND" },
    { error: new IfMatchRequiredError("absent"), status: 428, code: "IF_MATCH_REQUIRED" },
    { error: new VersionConflictError(diff), status: 409, code: "VERSION_CONFLICT" },
    { error: new CaseStateError("bad state"), status: 409, code: "INVALID_CASE_STATE" },
    { error: new FourEyesViolationError("c1"), status: 403, code: "FOUR_EYES_SELF_PROMOTE" },
  ];

  for (const c of cases) {
    it(`${c.error.name} -> ${c.status} ${c.code} (never 500)`, () => {
      expect(c.error).toBeInstanceOf(AppError);
      const { status, payload } = toErrorPayload(c.error, "req-1");
      expect(status).toBe(c.status);
      expect(payload.code).toBe(c.code);
      expect(payload.requestId).toBe("req-1");
      // CONS-F4: the authoring taxonomy's own codes must follow the SCREAMING_SNAKE
      // convention the rest of @testkite/contract's HTTP-facing errors use.
      expect(payload.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    });
  }

  it("VersionConflictError keeps its 3-way diff for the 409 body", () => {
    const err = new VersionConflictError(diff);
    expect(err.diff).toBe(diff);
    expect(err.httpStatus).toBe(409);
  });

  it("VersionConflictError's diff reaches the payload through publicExtras(), not duck-typing", () => {
    const { payload } = toErrorPayload(new VersionConflictError(diff), "req-1");
    expect(payload.diff).toEqual(diff);
  });
});
