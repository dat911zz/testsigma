import { assertTenantContext } from "../db/repo.js";
import { krnOutbox } from "../db/schema.js";
import type { TenantContext, TkTx } from "../db/types.js";

export type OutboxEvent = {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
};

/**
 * Ghi domain event vào outbox. CHỈ nhận TkTx (không nhận TkDb): kiểu ép người gọi
 * phải đang ở trong một transaction, nên event không bao giờ tồn tại mà thiếu
 * domain write đi kèm — và ngược lại. Không có side-effect nào ngoài transaction.
 *
 * Lệch có chủ đích so với block trong plan: dùng query builder thay cho
 * `tx.execute(sql`INSERT ... RETURNING id`)`. Lý do: `TkTx` là kiểu driver-agnostic
 * (`PgQueryResultHKT` chưa gắn driver) nên `execute()` trả `unknown` — đọc `.rows`
 * bắt buộc phải cast, mà TS strict của TestKite cấm cast vô cớ. `.returning()` cho
 * kiểu thật `{ id: bigint }[]`, SQL sinh ra vẫn là INSERT ... RETURNING "id".
 */
export async function enqueueOutbox(
  tx: TkTx,
  ctx: TenantContext,
  event: OutboxEvent,
): Promise<bigint> {
  const teamId = assertTenantContext(ctx);
  if (event.topic.trim().length === 0) {
    throw new Error("outbox: topic không được rỗng");
  }
  const rows = await tx
    .insert(krnOutbox)
    .values({ teamId, topic: event.topic, payload: event.payload })
    .returning({ id: krnOutbox.id });
  const row = rows[0];
  if (row === undefined) throw new Error("outbox: INSERT không trả id");
  return row.id;
}
