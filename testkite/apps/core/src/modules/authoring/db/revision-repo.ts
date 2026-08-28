import { and, eq } from "drizzle-orm";
import { TenantRepo, type TenantContext, type TkTx } from "../../kernel/index.js";
import { decodeRevision, encodeRevision, type RevisionCodec } from "../revision/codec.js";
import type { RevisionPayload } from "../revision/payload.js";
import { autCaseRevisions } from "./schema.js";

export interface InsertRevisionInput {
  readonly caseId: string;
  /** Bất biến: bằng `caseVersion` tại thời điểm ghi. */
  readonly revisionNo: number;
  readonly caseVersion: number;
  readonly payload: RevisionPayload;
  readonly actorUserId: string;
  readonly note?: string | undefined;
}

/**
 * APPEND-ONLY: lớp này CỐ TÌNH không có update/delete. Không phải kỷ luật — role
 * `testkite_app` không có grant UPDATE/DELETE trên bảng này, nên thêm phương thức
 * đó vào cũng chỉ nhận `permission denied` lúc chạy.
 */
export class RevisionRepo extends TenantRepo {
  constructor(tx: TkTx, ctx: TenantContext) {
    super(tx, ctx);
  }

  async insert(input: InsertRevisionInput): Promise<string> {
    const enc = encodeRevision(input.payload);
    const rows = await this.tx
      .insert(autCaseRevisions)
      .values({
        teamId: this.teamId,
        caseId: input.caseId,
        revisionNo: input.revisionNo,
        caseVersion: input.caseVersion,
        codec: enc.codec,
        payload: enc.bytes,
        payloadSize: enc.rawSize,
        payloadSha256: enc.sha256,
        createdBy: input.actorUserId,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      .returning({ id: autCaseRevisions.id });
    const row = rows[0];
    if (row === undefined) throw new Error("aut_case_revisions: INSERT không trả id");
    return row.id;
  }

  async findByCaseVersion(
    caseId: string,
    caseVersion: number,
  ): Promise<{ id: string; payload: RevisionPayload } | undefined> {
    const rows = await this.tx
      .select()
      .from(autCaseRevisions)
      .where(
        and(
          eq(autCaseRevisions.teamId, this.teamId),
          eq(autCaseRevisions.caseId, caseId),
          eq(autCaseRevisions.caseVersion, caseVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, payload: decodeRevision(row.codec as RevisionCodec, row.payload) as RevisionPayload };
  }

  async loadPayload(revisionId: string): Promise<RevisionPayload> {
    const rows = await this.tx
      .select()
      .from(autCaseRevisions)
      .where(and(eq(autCaseRevisions.teamId, this.teamId), eq(autCaseRevisions.id, revisionId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error(`aut_case_revisions: không thấy revision ${revisionId}`);
    return decodeRevision(row.codec as RevisionCodec, row.payload) as RevisionPayload;
  }
}
