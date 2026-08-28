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

/** L1: every query carries the TenantContext's `teamId`, never trusting RLS alone. */
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
    if (row === undefined) throw new Error("aut_cases: INSERT returned no row");
    return row;
  }

  /**
   * Write lock keyed by (team, case) — must be called BEFORE ANY READ in a
   * check-then-act mutation, otherwise two transactions both read the stale state and
   * both write.
   *
   * `pg_advisory_xact_lock` releases automatically when the transaction ends (COMMIT or
   * ROLLBACK), so there's no `unlock` to forget; never use the session-scoped variant on
   * the request path. The lock is a SINGLE bigint `hashtextextended(team||':'||case, 0)` —
   * the 2×int4 form only has 32 bits per side, so it collides more. A bigint hash collision
   * can still happen; the only consequence is two unrelated cases queuing behind each other,
   * which is exactly what "advisory" means. The lock key carries `teamId`, so another
   * tenant's id can't block anyone — and since it only locks a number, it never reveals
   * whether a case exists.
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

  /** Delete by case: FK ON DELETE CASCADE also cleans up child steps, loops, and rests. */
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
    // Parent must exist before child (self-FK) — flattenStepInputs already returns them in pre-order.
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

  /** Bump version + stamp the editor. Editing a `ready` case sends it back to `draft`. */
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
    if (row === undefined) throw new Error("aut_cases: UPDATE returned no row");
    return row;
  }

  /** draft -> in_review. Bump version because a status change is a change too. */
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
    if (row === undefined) throw new Error("aut_cases: UPDATE returned no row");
    return row;
  }

  /**
   * Review outcome. `approved` KEEPS in_review (promote is a separate step);
   * `changes_requested` and `withdraw` send it back to draft.
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
    if (row === undefined) throw new Error("aut_cases: UPDATE returned no row");
    return row;
  }

  /**
   * in_review (approved) -> ready. PINS `ready_revision_id` = the current latest:
   * from here on, schedule/CI compiles EXACTLY this version even if the author keeps
   * editing (blueprint §4 phase 1) — `applyEdit` deliberately does NOT touch this column.
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
    if (row === undefined) throw new Error("aut_cases: UPDATE returned no row");
    return row;
  }

  async setLatestRevision(caseId: string, revisionId: string): Promise<CaseRow> {
    const rows = await this.tx
      .update(autCases)
      .set({ latestRevisionId: revisionId })
      .where(and(eq(autCases.teamId, this.teamId), eq(autCases.id, caseId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_cases: UPDATE returned no row");
    return row;
  }
}
