import { and, asc, eq, sql } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { autCases, autRestSteps, autStepLoops, autSteps } from "./schema.js";
import type { LoopRow, RestRow, StepRow } from "../steps-flatten.js";

export type CaseRow = typeof autCases.$inferSelect;

export interface InsertCaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string | undefined;
  readonly dataProfileId?: string | undefined;
  readonly actorUserId: string;
}

/** L1: mọi truy vấn đều mang `teamId` của TenantContext, không tin RLS một mình. */
export class CaseRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async insertCase(input: InsertCaseInput): Promise<CaseRow> {
    const rows = await this.tx
      .insert(autCases)
      .values({
        teamId: this.teamId,
        projectId: input.projectId,
        name: input.name,
        isStepGroup: input.isStepGroup,
        ...(input.prereqCaseId === undefined ? {} : { prereqCaseId: input.prereqCaseId }),
        lastEditedBy: input.actorUserId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: INSERT không trả row");
    return row;
  }

  /**
   * Khoá ghi theo (team, case) — phải gọi TRƯỚC MỌI ĐỌC của một mutation kiểu
   * check-then-act, nếu không hai transaction cùng đọc trạng thái cũ rồi cùng ghi.
   *
   * `pg_advisory_xact_lock` tự nhả khi transaction kết thúc (COMMIT hoặc ROLLBACK)
   * nên không có `unlock` nào để quên; không bao giờ dùng bản session-scope trong
   * request path. Khoá là MỘT bigint `hashtextextended(team||':'||case, 0)` — dạng
   * 2×int4 chỉ có 32 bit mỗi vế nên đụng độ nhiều hơn. Đụng độ hash bigint vẫn có
   * thể xảy ra; hậu quả duy nhất là hai case không liên quan xếp hàng nhau, đúng
   * bản chất "advisory". Khoá mang `teamId` nên id của tenant khác không chặn được
   * ai — và vì chỉ khoá số, nó không hé lộ case có tồn tại hay không.
   */
  async lockCase(caseId: string): Promise<void> {
    const key = `${this.teamId}:${caseId}`;
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
  }

  async findById(caseId: string): Promise<CaseRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCases)
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .limit(1);
    return rows[0];
  }

  async listStepRows(caseId: string): Promise<StepRow[]> {
    const rows = await this.tx
      .select()
      .from(autSteps)
      .where(and(eq(autSteps.teamId, this.teamId), eq(autSteps.caseId, caseId)))
      .orderBy(asc(autSteps.ordinal), asc(autSteps.id));
    return rows.map((r) => ({
      id: r.id,
      caseId: r.caseId,
      parentStepId: r.parentStepId,
      ordinal: r.ordinal,
      kind: r.kind,
      renderedSentence: r.renderedSentence,
      verbOpKey: r.verbOpKey,
      elementId: r.elementId,
      args: r.args as Record<string, string> | null,
      stepGroupCaseId: r.stepGroupCaseId,
      conditionExpected: r.conditionExpected,
    }));
  }

  /** Xoá theo case: FK ON DELETE CASCADE dọn luôn step con, loop và rest. */
  async deleteSteps(caseId: string): Promise<void> {
    await this.tx
      .delete(autSteps)
      .where(and(eq(autSteps.teamId, this.teamId), eq(autSteps.caseId, caseId)));
  }

  async insertSteps(
    steps: readonly StepRow[],
    loops: readonly LoopRow[],
    rests: readonly RestRow[],
  ): Promise<void> {
    if (steps.length === 0) return;
    // Cha phải có trước con (self-FK) — flattenStepInputs đã trả theo thứ tự duyệt trước.
    for (const s of steps) {
      await this.tx.insert(autSteps).values({
        teamId: this.teamId,
        id: s.id,
        caseId: s.caseId,
        parentStepId: s.parentStepId,
        ordinal: s.ordinal,
        kind: s.kind,
        renderedSentence: s.renderedSentence,
        verbOpKey: s.verbOpKey,
        elementId: s.elementId,
        args: s.args,
        stepGroupCaseId: s.stepGroupCaseId,
        conditionExpected: s.conditionExpected,
      });
    }
    for (const l of loops) {
      await this.tx.insert(autStepLoops).values({
        teamId: this.teamId,
        stepId: l.stepId,
        dataProfileId: l.dataProfileId,
        maxIterations: l.maxIterations,
      });
    }
    for (const r of rests) {
      await this.tx.insert(autRestSteps).values({
        teamId: this.teamId,
        stepId: r.stepId,
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.body,
        storeAs: r.storeAs,
      });
    }
  }

  /** Bump version + đóng dấu người sửa. Sửa case `ready` đưa nó về `draft`. */
  async applyEdit(
    caseId: string,
    nextVersion: number,
    actorUserId: string,
    revisionId: string,
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "draft",
        updatedAt: new Date(),
        lastEditedBy: actorUserId,
        latestRevisionId: revisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  /** draft -> in_review. Bump version vì trạng thái đổi cũng là một thay đổi. */
  async applySubmit(
    caseId: string,
    nextVersion: number,
    actorUserId: string,
    revisionId: string,
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "in_review",
        submittedAt: new Date(),
        submittedBy: actorUserId,
        updatedAt: new Date(),
        latestRevisionId: revisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  /**
   * Kết quả review. `approved` GIỮ in_review (promote là bước riêng);
   * `changes_requested` và `withdraw` đưa về draft.
   */
  async applyDecision(
    caseId: string,
    nextVersion: number,
    nextStatus: "draft" | "in_review",
    reviewer: { readonly userId: string; readonly stampReviewed: boolean },
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: nextStatus,
        updatedAt: new Date(),
        ...(reviewer.stampReviewed ? { reviewedAt: new Date(), reviewedBy: reviewer.userId } : {}),
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  /**
   * in_review (đã approved) -> ready. GHIM `ready_revision_id` = bản đang latest:
   * từ đây schedule/CI compile ĐÚNG bản này kể cả khi tác giả sửa tiếp (blueprint §4
   * phase 1) — `applyEdit` cố tình KHÔNG đụng cột này.
   */
  async applyPromote(
    caseId: string,
    nextVersion: number,
    actorUserId: string,
    readyRevisionId: string,
  ): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({
        version: nextVersion,
        status: "ready",
        promotedAt: new Date(),
        promotedBy: actorUserId,
        updatedAt: new Date(),
        readyRevisionId,
      })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }

  async setLatestRevision(caseId: string, revisionId: string): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({ latestRevisionId: revisionId })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE không trả row");
    return row;
  }
}
