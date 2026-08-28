/**
 * The "edit" half of a case's lifecycle. Every function here TAKES a TkTx: they must run
 * inside a transaction opened by `withTenant` (app role + app.team_id already set), so
 * there can never be an authoring write path that doesn't carry a tenant.
 */
import { randomUUID } from "node:crypto";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo, type CaseRow } from "./db/case-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { CaseNotFoundError, CaseStateError, VersionConflictError } from "./errors.js";
import { threeWayDiff } from "./revision/diff.js";
import type { RevisionCase, RevisionPayload } from "./revision/payload.js";
import { buildRevisionPayload, flattenStepInputs } from "./steps-flatten.js";

export interface Actor {
  readonly userId: string;
}

export interface CreateCaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string | undefined;
  readonly dataProfileId?: string | undefined;
}

export interface ReplaceStepsInput {
  readonly caseId: string;
  readonly expectedVersion: number;
  readonly steps: readonly StepInputDto[];
}

export function toCaseSummary(row: CaseRow): CaseSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    isStepGroup: row.isStepGroup,
    status: row.status,
    version: row.version,
    ...(row.prereqCaseId === null ? {} : { prereqCaseId: row.prereqCaseId }),
    ...(row.latestRevisionId === null ? {} : { latestRevisionId: row.latestRevisionId }),
    ...(row.readyRevisionId === null ? {} : { readyRevisionId: row.readyRevisionId }),
    ...(row.lastEditedBy === null ? {} : { lastEditedBy: row.lastEditedBy }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Three workflow milestones: the null check happens RIGHT at the use site so no `!`
    // is needed — TS narrows the type within the expression itself, unlike going through a helper function.
    ...(row.submittedAt === null ? {} : { submittedAt: row.submittedAt.toISOString() }),
    ...(row.reviewedAt === null ? {} : { reviewedAt: row.reviewedAt.toISOString() }),
    ...(row.promotedAt === null ? {} : { promotedAt: row.promotedAt.toISOString() }),
  };
}

function caseOf(row: CaseRow): RevisionCase {
  return {
    name: row.name,
    isStepGroup: row.isStepGroup,
    ...(row.prereqCaseId === null ? {} : { prereqCaseId: row.prereqCaseId }),
  };
}

export async function createCase(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CreateCaseInput,
): Promise<CaseSummaryDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);
  const row = await cases.insertCase({
    projectId: input.projectId,
    name: input.name,
    isStepGroup: input.isStepGroup,
    ...(input.prereqCaseId === undefined ? {} : { prereqCaseId: input.prereqCaseId }),
    actorUserId: actor.userId,
  });
  // Revision #1 is written IMMEDIATELY even when the case has no steps yet: `latest` is
  // never NULL after creation, so the compiler always has a version to pin (blueprint §4 phase 1).
  const revisionId = await revisions.insert({
    caseId: row.id,
    revisionNo: 1,
    caseVersion: 1,
    payload: { case: caseOf(row), steps: [] },
    actorUserId: actor.userId,
    note: "created",
  });
  const withRevision = await cases.setLatestRevision(row.id, revisionId);
  return toCaseSummary(withRevision);
}

export async function replaceSteps(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: ReplaceStepsInput,
): Promise<CaseSummaryDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);

  // LOCK BEFORE ANY READ. Comparing `version` to `expectedVersion` and then writing is
  // check-then-act: without a lock, two requests sharing the same `expectedVersion` on two
  // real connections both read the SAME stale version (neither has committed yet), so BOTH
  // pass the comparison branch and both write — the loser hits the `aut_steps_position_unique`
  // constraint (every replace renumbers ordinals from 1) and throws a raw
  // DrizzleQueryError/23505 instead of the 409 + three-way-diff contract.
  // RED→GREEN evidence: test/concurrency/case-edit-race.test.ts against real Postgres.
  // The lock is acquired before the existence check itself: it only locks a number, reads
  // no row, so it can't change the "cross-tenant ⇒ 404" rule.
  await cases.lockCase(input.caseId);

  const row = await cases.findById(input.caseId);
  // Another tenant ⇒ RLS already filtered the row out ⇒ 404. NEVER 403 (blueprint §3 L3).
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.status === "in_review") {
    throw new CaseStateError(
      `Case ${input.caseId} is in_review — withdraw the review before editing (POST /cases/:id/withdraw-review)`,
    );
  }

  const existingRows = await cases.listStepRows(input.caseId);
  const existingIds = new Set(existingRows.map((s) => s.id));
  const flat = flattenStepInputs({
    caseId: input.caseId,
    steps: input.steps,
    existingIds,
    newId: () => randomUUID(),
  });
  const minePayload = buildRevisionPayload({
    case: caseOf(row),
    steps: flat.steps,
    loops: flat.loops,
    rests: flat.rests,
  });

  if (row.version !== input.expectedVersion) {
    const currentRevisionId = row.latestRevisionId;
    if (currentRevisionId === null) {
      throw new CaseStateError(`Case ${input.caseId} has no revision — inconsistent data`);
    }
    const base = await revisions.findByCaseVersion(input.caseId, input.expectedVersion);
    const theirs = await revisions.loadPayload(currentRevisionId);
    // Can't find the revision for the version the client is holding (only happens after
    // manual data intervention): fall back to the current version as base — the diff still
    // points the right direction, just less precise.
    const basePayload: RevisionPayload = base?.payload ?? theirs;
    throw new VersionConflictError(
      threeWayDiff({
        base: basePayload,
        mine: minePayload,
        theirs,
        baseVersion: input.expectedVersion,
        baseRevisionId: base?.id ?? currentRevisionId,
        currentVersion: row.version,
        currentRevisionId,
      }),
    );
  }

  await cases.deleteSteps(input.caseId);
  await cases.insertSteps(flat.steps, flat.loops, flat.rests);
  const nextVersion = row.version + 1;
  const revisionId = await revisions.insert({
    caseId: input.caseId,
    revisionNo: nextVersion,
    caseVersion: nextVersion,
    payload: minePayload,
    actorUserId: actor.userId,
    note: "steps replaced",
  });
  const updated = await cases.applyEdit(input.caseId, nextVersion, actor.userId, revisionId);
  return toCaseSummary(updated);
}
