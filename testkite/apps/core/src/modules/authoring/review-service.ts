/**
 * Review state machine. Every function takes a TkTx (running inside withTenant) and
 * requires `expectedVersion` — a state change is a mutation too, so it must carry If-Match.
 */
import { eq } from "drizzle-orm";
import type { CaseSummaryDto, ReviewDecisionDto } from "@testkite/contract";
// Forward along the DAG: the four-eyes flag lives on identity's `teams` — read it through the
// FACADE, don't touch `identity/db/schema.js`.
import { teams } from "../identity/index.js";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo, type CaseRow } from "./db/case-repo.js";
import { ReviewRepo } from "./db/review-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { toCaseSummary, type Actor } from "./case-service.js";
import {
  CaseNotFoundError,
  CaseStateError,
  FourEyesViolationError,
  VersionConflictError,
} from "./errors.js";
import { threeWayDiff } from "./revision/diff.js";

export interface CaseMutationInput {
  readonly caseId: string;
  readonly expectedVersion: number;
}

export interface DecideReviewInput extends CaseMutationInput {
  readonly decision: ReviewDecisionDto;
  readonly comment?: string | undefined;
}

/**
 * 409 for mutations that carry NO payload (submit/withdraw/decide/promote): `mine` is
 * base itself, so the "mine" side is empty — the client isn't proposing any content
 * change, it's just standing on a stale version. The `theirs` side still shows what changed.
 */
async function conflictFor(
  tx: TkTx,
  ctx: TenantContext,
  row: CaseRow,
  expectedVersion: number,
): Promise<VersionConflictError> {
  const revisions = new RevisionRepo(tx, ctx);
  const currentRevisionId = row.latestRevisionId;
  if (currentRevisionId === null) {
    throw new CaseStateError(`Case ${row.id} has no revision — inconsistent data`);
  }
  const theirs = await revisions.loadPayload(currentRevisionId);
  const base = await revisions.findByCaseVersion(row.id, expectedVersion);
  const basePayload = base?.payload ?? theirs;
  return new VersionConflictError(
    threeWayDiff({
      base: basePayload,
      mine: basePayload,
      theirs,
      baseVersion: expectedVersion,
      baseRevisionId: base?.id ?? currentRevisionId,
      currentVersion: row.version,
      currentRevisionId,
    }),
  );
}

/**
 * The ONE entry point for every state mutation (submit/withdraw/decide) — so the lock
 * lives here, not scattered across three call sites.
 *
 * LOCK BEFORE ANY READ. Comparing `version` to `expectedVersion` and then writing is
 * check-then-act exactly like `replaceSteps`: without a lock, two transactions on two real
 * connections both read the SAME stale version (neither has committed yet), so BOTH pass
 * the comparison branch and both write.
 * Measured for real on Postgres (test/concurrency/review-state-race.test.ts):
 *  - `decide('approved')` racing `withdraw` ⇒ both return SUCCESS, but the DB can only keep
 *    one decision — a silent lost update, and the losing side's response describes a state that
 *    never existed;
 *  - two `submitForReview` calls ⇒ the loser hits a unique constraint (revision_no /
 *    `aut_case_reviews_one_open`) and throws a RAW DrizzleQueryError/23505 instead of the
 *    409 + three-way-diff contract.
 * The lock is acquired before the existence check itself: it only locks a number, reads no
 * row, so it can't change the "cross-tenant ⇒ 404" rule.
 */
async function loadForMutation(
  tx: TkTx,
  ctx: TenantContext,
  input: CaseMutationInput,
): Promise<CaseRow> {
  const cases = new CaseRepo(tx, ctx);
  await cases.lockCase(input.caseId);
  const row = await cases.findById(input.caseId);
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.version !== input.expectedVersion) {
    throw await conflictFor(tx, ctx, row, input.expectedVersion);
  }
  return row;
}

export async function submitForReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "draft") {
    throw new CaseStateError(`Only a draft case can be submitted; case ${row.id} is currently ${row.status}`);
  }
  const revisionId = row.latestRevisionId;
  if (revisionId === null) throw new CaseStateError(`Case ${row.id} has no revision to submit for review`);

  const nextVersion = row.version + 1;
  const revisions = new RevisionRepo(tx, ctx);
  // Write a milestone revision for this submit itself: the reviewed version is a fixed point
  // in history, not "whatever was latest when someone opened the page".
  const submittedRevisionId = await revisions.insert({
    caseId: row.id,
    revisionNo: nextVersion,
    caseVersion: nextVersion,
    payload: await revisions.loadPayload(revisionId),
    actorUserId: actor.userId,
    note: "submitted for review",
  });
  await new ReviewRepo(tx, ctx).open(row.id, submittedRevisionId, actor.userId);
  const updated = await new CaseRepo(tx, ctx).applySubmit(
    row.id,
    nextVersion,
    actor.userId,
    submittedRevisionId,
  );
  return toCaseSummary(updated);
}

export async function withdrawReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`No review to withdraw; case ${row.id} is currently ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} has no open review`);
  await reviews.close(open.id, "withdrawn", actor.userId);
  const updated = await new CaseRepo(tx, ctx).applyDecision(row.id, row.version + 1, "draft", {
    userId: actor.userId,
    stampReviewed: false,
  });
  return toCaseSummary(updated);
}

export async function decideReview(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: DecideReviewInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Only an in_review case can be reviewed; case ${row.id} is currently ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} has no open review`);

  await reviews.close(open.id, input.decision, actor.userId, input.comment);
  const approved = input.decision === "approved";
  const updated = await new CaseRepo(tx, ctx).applyDecision(
    row.id,
    row.version + 1,
    approved ? "in_review" : "draft",
    { userId: actor.userId, stampReviewed: approved },
  );
  return toCaseSummary(updated);
}

/**
 * in_review (approved) -> ready. THE ORDER BELOW IS PART OF CORRECTNESS:
 *   1. advisory lock BEFORE reading anything — taken after the read, two concurrent
 *      promotes would both see `in_review` and both proceed;
 *   2. only then read the case (404) / check version (409) / check status (409) /
 *      check the review is approved (409) / check four-eyes (403) / write.
 * The first three steps are `loadForMutation` — the same entry point as submit/withdraw/
 * decide, so the lock can never be forgotten on some call path.
 *
 * Does NOT write a new revision: the case content doesn't change, only the
 * `ready_revision_id` pointer moves — writing an identical revision would just bloat
 * history. `version` still bumps because the case's ETag has changed.
 */
export async function promoteCase(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Only an in_review case can be promoted; case ${row.id} is currently ${row.status}`);
  }

  const latestReview = await new ReviewRepo(tx, ctx).findLatest(row.id);
  if (latestReview === undefined || latestReview.state !== "approved") {
    throw new CaseStateError(`Case ${row.id} has not been approved — promote requires an 'approved' review`);
  }

  // FOUR-EYES (blueprint §3): the last editor cannot self-promote. Applies ONLY to promote,
  // not to review — an editor approving someone else's version is still valid.
  if (row.lastEditedBy === actor.userId) {
    const teamRows = await tx
      .select({ allowSelfPromote: teams.allowSelfPromote })
      .from(teams)
      .where(eq(teams.id, ctx.teamId))
      .limit(1);
    const allowSelfPromote = teamRows[0]?.allowSelfPromote ?? false;
    if (!allowSelfPromote) throw new FourEyesViolationError(row.id);
  }

  const readyRevisionId = row.latestRevisionId;
  if (readyRevisionId === null) throw new CaseStateError(`Case ${row.id} has no revision to pin`);

  const nextVersion = row.version + 1;
  const updated = await new CaseRepo(tx, ctx).applyPromote(
    row.id,
    nextVersion,
    actor.userId,
    readyRevisionId,
  );
  return toCaseSummary(updated);
}
