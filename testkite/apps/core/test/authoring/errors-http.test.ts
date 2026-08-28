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
    { error: new IfMatchRequiredError("absent"), status: 428, code: "if_match_required" },
    { error: new VersionConflictError(diff), status: 409, code: "version_conflict" },
    { error: new CaseStateError("bad state"), status: 409, code: "invalid_case_state" },
    { error: new FourEyesViolationError("c1"), status: 403, code: "four_eyes_self_promote" },
  ];

  for (const c of cases) {
    it(`${c.error.name} -> ${c.status} ${c.code} (never 500)`, () => {
      expect(c.error).toBeInstanceOf(AppError);
      const { status, payload } = toErrorPayload(c.error, "req-1");
      expect(status).toBe(c.status);
      expect(payload.code).toBe(c.code);
      expect(payload.requestId).toBe("req-1");
    });
  }

  it("VersionConflictError keeps its 3-way diff for the 409 body", () => {
    const err = new VersionConflictError(diff);
    expect(err.diff).toBe(diff);
    expect(err.httpStatus).toBe(409);
  });
});
