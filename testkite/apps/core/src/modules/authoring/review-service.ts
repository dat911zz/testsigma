/**
 * Máy trạng thái review. Mọi hàm nhận TkTx (chạy trong withTenant) và đòi
 * `expectedVersion` — đổi trạng thái cũng là mutation, cũng phải mang If-Match.
 */
import type { CaseSummaryDto, ReviewDecisionDto } from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo, type CaseRow } from "./db/case-repo.js";
import { ReviewRepo } from "./db/review-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { toCaseSummary, type Actor } from "./case-service.js";
import { CaseNotFoundError, CaseStateError, VersionConflictError } from "./errors.js";
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
 * 409 cho mutation KHÔNG mang payload (submit/withdraw/decide/promote): `mine` là
 * chính base nên nhánh "mine" rỗng — client không đề xuất thay đổi nội dung nào,
 * nó chỉ đang đứng trên một bản cũ. Nhánh `theirs` vẫn cho thấy đã có gì đổi.
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
    throw new CaseStateError(`Case ${row.id} chưa có revision — dữ liệu không nhất quán`);
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

async function loadForMutation(
  tx: TkTx,
  ctx: TenantContext,
  input: CaseMutationInput,
): Promise<CaseRow> {
  const row = await new CaseRepo(tx, ctx).findById(input.caseId);
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
    throw new CaseStateError(`Chỉ case draft mới submit được; case ${row.id} đang ${row.status}`);
  }
  const revisionId = row.latestRevisionId;
  if (revisionId === null) throw new CaseStateError(`Case ${row.id} chưa có revision để đưa ra review`);

  const nextVersion = row.version + 1;
  const revisions = new RevisionRepo(tx, ctx);
  // Ghi một revision mốc cho chính lần submit: bản được review là một điểm cố định
  // trong lịch sử, không phải "bản mới nhất lúc ai đó mở trang".
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
    throw new CaseStateError(`Không có review để rút; case ${row.id} đang ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} không có review đang mở`);
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
    throw new CaseStateError(`Chỉ case in_review mới review được; case ${row.id} đang ${row.status}`);
  }
  const reviews = new ReviewRepo(tx, ctx);
  const open = await reviews.findOpen(row.id);
  if (open === undefined) throw new CaseStateError(`Case ${row.id} không có review đang mở`);

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
