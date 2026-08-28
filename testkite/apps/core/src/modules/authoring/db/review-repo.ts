import { and, desc, eq } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { autCaseReviews } from "./schema.js";

export type ReviewRow = typeof autCaseReviews.$inferSelect;
export type ReviewClosedState = "approved" | "changes_requested" | "withdrawn";

/**
 * L1: mọi truy vấn mang `teamId` của TenantContext. Cố tình KHÔNG có `delete`:
 * role app không có GRANT DELETE trên bảng này (0013_aut_case_reviews_grants.sql)
 * — lịch sử ai yêu cầu / ai duyệt là bằng chứng four-eyes.
 */
export class ReviewRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async open(caseId: string, revisionId: string, requestedBy: string): Promise<ReviewRow> {
    const rows = await this.tx
      .insert(autCaseReviews)
      .values({ teamId: this.teamId, caseId, revisionId, state: "open", requestedBy })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_reviews: INSERT không trả row");
    return row;
  }

  async findOpen(caseId: string): Promise<ReviewRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseReviews)
      .where(
        and(
          eq(autCaseReviews.teamId, this.teamId),
          eq(autCaseReviews.caseId, caseId),
          eq(autCaseReviews.state, "open"),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findLatest(caseId: string): Promise<ReviewRow | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseReviews)
      .where(and(eq(autCaseReviews.teamId, this.teamId), eq(autCaseReviews.caseId, caseId)))
      .orderBy(desc(autCaseReviews.requestedAt), desc(autCaseReviews.id))
      .limit(1);
    return rows[0];
  }

  async close(
    reviewId: string,
    state: ReviewClosedState,
    decidedBy: string,
    comment?: string | undefined,
  ): Promise<ReviewRow> {
    const rows = await this.tx
      .update(autCaseReviews)
      .set({
        state,
        decidedBy,
        decidedAt: new Date(),
        ...(comment === undefined ? {} : { comment }),
      })
      .where(and(eq(autCaseReviews.teamId, this.teamId), eq(autCaseReviews.id, reviewId)))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_reviews: UPDATE không trả row");
    return row;
  }
}
