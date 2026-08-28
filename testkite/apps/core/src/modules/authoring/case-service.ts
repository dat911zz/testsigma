/**
 * Vòng đời phần "sửa" của case. Mọi hàm ở đây NHẬN TkTx: chúng phải chạy trong
 * transaction do `withTenant` mở (role app + app.team_id đã set), nên không thể
 * tồn tại một đường ghi authoring nào không mang tenant.
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
    // Ba mốc workflow: kiểm tra null NGAY tại chỗ dùng nên không cần `!` — TS thu
    // hẹp kiểu trong chính biểu thức, khác với việc đi qua một hàm trợ giúp.
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
  // Revision #1 ghi NGAY cả khi case chưa có step: `latest` không bao giờ NULL sau
  // khi tạo, nên compiler luôn có bản để ghim (blueprint §4 phase 1).
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

  const row = await cases.findById(input.caseId);
  // Tenant khác ⇒ RLS đã lọc mất row ⇒ 404. KHÔNG BAO GIỜ 403 (blueprint §3 L3).
  if (row === undefined) throw new CaseNotFoundError(input.caseId);
  if (row.status === "in_review") {
    throw new CaseStateError(
      `Case ${input.caseId} đang in_review — rút review trước khi sửa (POST /cases/:id/withdraw-review)`,
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
      throw new CaseStateError(`Case ${input.caseId} chưa có revision — dữ liệu không nhất quán`);
    }
    const base = await revisions.findByCaseVersion(input.caseId, input.expectedVersion);
    const theirs = await revisions.loadPayload(currentRevisionId);
    // Không tìm được revision của version client cầm (chỉ xảy ra sau can thiệp dữ
    // liệu thủ công): lấy bản hiện tại làm base — diff vẫn đúng chiều, chỉ kém tinh.
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
