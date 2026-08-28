import { and, asc, eq } from "drizzle-orm";
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
