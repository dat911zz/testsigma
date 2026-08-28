/**
 * Máy trạng thái review. Mọi hàm nhận TkTx (chạy trong withTenant) và đòi
 * `expectedVersion` — đổi trạng thái cũng là mutation, cũng phải mang If-Match.
 */
import { eq } from "drizzle-orm";
import type { CaseSummaryDto, ReviewDecisionDto } from "@testkite/contract";
// Xuôi DAG: cờ four-eyes nằm ở `teams` của identity — đọc qua FACADE, không chạm
// `identity/db/schema.js`.
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

/**
 * Cửa vào DUY NHẤT của mọi mutation trạng thái (submit/withdraw/decide) — nên khoá
 * đứng ở đây, không rải ở ba chỗ gọi.
 *
 * KHOÁ TRƯỚC MỌI ĐỌC. So `version` với `expectedVersion` rồi mới ghi là check-then-act
 * y hệt `replaceSteps`: không có khoá, hai transaction trên hai connection thật đều đọc
 * trúng version CŨ (chưa bên nào commit) nên CẢ HAI qua được nhánh so sánh và cùng ghi.
 * Đo thật trên Postgres (test/concurrency/review-state-race.test.ts):
 *  - `decide('approved')` song song `withdraw` ⇒ cả hai trả THÀNH CÔNG, DB chỉ giữ được
 *    một quyết định — lost update im lặng, response bên thua mô tả trạng thái không có thật;
 *  - hai `submitForReview` ⇒ bên thua đâm unique (revision_no / `aut_case_reviews_one_open`)
 *    và ném DrizzleQueryError/23505 THÔ thay vì hợp đồng 409 + diff 3 chiều.
 * Khoá đứng trước cả kiểm tra tồn tại: nó chỉ khoá một số, không đọc row nào, nên không
 * đổi được luật "cross-tenant ⇒ 404".
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

/**
 * in_review (đã approved) -> ready. THỨ TỰ DƯỚI ĐÂY LÀ MỘT PHẦN CỦA TÍNH ĐÚNG ĐẮN:
 *   1. advisory lock TRƯỚC khi đọc bất cứ thứ gì — lấy sau khi đọc thì hai promote
 *      song song cùng thấy `in_review` rồi cùng đi tiếp;
 *   2. rồi mới đọc case (404) / kiểm version (409) / kiểm trạng thái (409) /
 *      kiểm review đã approved (409) / kiểm four-eyes (403) / ghi.
 * Ba bước đầu là `loadForMutation` — cùng một cửa với submit/withdraw/decide, nên
 * khoá không bao giờ bị bỏ quên ở một nhánh gọi nào.
 *
 * KHÔNG ghi revision mới: nội dung case không đổi, chỉ con trỏ `ready_revision_id`
 * dịch chuyển — ghi thêm một bản y hệt chỉ làm phình lịch sử. `version` vẫn bump vì
 * ETag của case đã đổi.
 */
export async function promoteCase(
  tx: TkTx,
  ctx: TenantContext,
  actor: Actor,
  input: CaseMutationInput,
): Promise<CaseSummaryDto> {
  const row = await loadForMutation(tx, ctx, input);
  if (row.status !== "in_review") {
    throw new CaseStateError(`Chỉ case in_review mới promote được; case ${row.id} đang ${row.status}`);
  }

  const latestReview = await new ReviewRepo(tx, ctx).findLatest(row.id);
  if (latestReview === undefined || latestReview.state !== "approved") {
    throw new CaseStateError(`Case ${row.id} chưa được duyệt — promote cần một review 'approved'`);
  }

  // FOUR-EYES (blueprint §3): người-sửa-cuối-không-tự-promote. CHỈ áp ở promote,
  // không áp ở review — người sửa duyệt bản của người khác vẫn hợp lệ.
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
  if (readyRevisionId === null) throw new CaseStateError(`Case ${row.id} chưa có revision để ghim`);

  const nextVersion = row.version + 1;
  const updated = await new CaseRepo(tx, ctx).applyPromote(
    row.id,
    nextVersion,
    actor.userId,
    readyRevisionId,
  );
  return toCaseSummary(updated);
}
