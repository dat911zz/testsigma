import { sql } from "drizzle-orm";
import type { TkDb } from "../db/types.js";

export type OutboxRecord = {
  readonly id: bigint;
  readonly teamId: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
};

export type Publisher = (rec: OutboxRecord) => Promise<void>;

export type RelayOptions = {
  readonly consumer: string;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
};

export type RelayResult = {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
};

/** Guard chứ không cast: `TkDb` cố ý driver-agnostic nên `execute()` trả `unknown`. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Đọc `rows` của một kết quả `execute()` mà không cast mù. Cả node-postgres lẫn
 * PGlite đều trả `{ rows: [...] }`; shape khác ⇒ ném ngay thay vì đọc bừa.
 */
function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(result)) throw new Error("relay: kết quả query không phải object");
  const rows: unknown = result["rows"];
  if (!Array.isArray(rows)) throw new Error("relay: kết quả query thiếu mảng rows");
  const list: readonly unknown[] = rows;
  return list.filter(isRecord);
}

/** `krn_outbox.id` là bigserial — driver trả string (pg) hoặc number/bigint (PGlite). */
function readId(row: Record<string, unknown>): bigint {
  const raw = row["id"];
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "string" || typeof raw === "number") return BigInt(raw);
  throw new Error(`relay: krn_outbox.id không đọc được (typeof=${typeof raw})`);
}

function toOutboxRecord(row: Record<string, unknown>, id: bigint): OutboxRecord {
  const payload = row["payload"];
  if (!isRecord(payload)) {
    // Poison message: writer luôn ghi object. Ném ở đây ⇒ event bị tính là failed,
    // tăng attempts và cuối cùng rơi ra khỏi batch qua maxAttempts, không kẹt relay.
    throw new Error(`relay: payload của event ${String(id)} không phải object JSON`);
  }
  return {
    id,
    teamId: String(row["team_id"]),
    topic: String(row["topic"]),
    payload,
    attempts: Number(row["attempts"]),
  };
}

/**
 * Một vòng relay. Mỗi event là MỘT transaction riêng:
 *   BEGIN → SELECT ... FOR UPDATE SKIP LOCKED (giữ khoá row)
 *         → publish (side-effect DUY NHẤT, nằm trong khoá)
 *         → INSERT consumed ... ON CONFLICT DO NOTHING → COMMIT
 * Publish ném ⇒ ROLLBACK phần đánh dấu, ghi attempts/last_error/available_at ở một
 * transaction riêng ⇒ at-least-once, không mất event, không chặn event khác.
 *
 * Đây là SKELETON: `publish` tiêm từ ngoài. Kernel không import bullmq (luật lint) —
 * đấu nối BullMQ thật là việc M3.
 *
 * `claimed` là số row câu SELECT trả về; `published + failed` có thể NHỎ HƠN khi một
 * relay khác đang giữ khoá row (SKIP LOCKED bỏ qua, không chờ) hoặc đã tiêu thụ xong
 * row đó (NOT EXISTS trong câu khoá) — hiệu số đó chính là phần việc thuộc về instance
 * kia, không phải lỗi.
 */
export async function runRelayOnce(
  db: TkDb,
  publish: Publisher,
  opts: RelayOptions,
): Promise<RelayResult> {
  const batchSize = opts.batchSize ?? 100;
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoffMs = opts.backoffMs ?? 5_000;

  const pending = rowsOf(
    await db.execute(sql`
      SELECT o.id, o.team_id, o.topic, o.payload, o.attempts
      FROM krn_outbox o
      WHERE o.available_at <= now()
        AND o.attempts < ${maxAttempts}
        AND NOT EXISTS (
          SELECT 1 FROM krn_outbox_consumed c
          WHERE c.outbox_id = o.id AND c.consumer = ${opts.consumer})
      ORDER BY o.id
      LIMIT ${batchSize}`),
  );

  let published = 0;
  let failed = 0;

  for (const row of pending) {
    const id = readId(row);
    try {
      const rec = toOutboxRecord(row, id);
      const done = await db.transaction(async (tx): Promise<boolean> => {
        // Khoá lại đúng row này; SKIP LOCKED để relay thứ hai đi tiếp row khác
        // thay vì xếp hàng chờ.
        //
        // NOT EXISTS PHẢI lặp lại ở đây, không chỉ ở câu SELECT batch: danh sách
        // candidate được chốt TRƯỚC mọi transaction nên nó là snapshot CŨ. Relay
        // khác cùng consumer có thể đã publish + COMMIT consumed cho row này rồi
        // NHẢ khoá trong lúc ta còn xử lý các row trước đó — khi đó SKIP LOCKED
        // không skip (row hết khoá) và ta sẽ publish lần hai. Câu này chạy trong
        // transaction riêng nên snapshot READ COMMITTED của nó thấy được commit
        // đó ⇒ 0 row ⇒ bỏ qua đúng.
        const locked = rowsOf(
          await tx.execute(sql`
            SELECT o.id FROM krn_outbox o
            WHERE o.id = ${String(id)}
              AND NOT EXISTS (
                SELECT 1 FROM krn_outbox_consumed c
                WHERE c.outbox_id = o.id AND c.consumer = ${opts.consumer})
            FOR UPDATE SKIP LOCKED`),
        );
        if (locked.length === 0) return false; // relay khác đang cầm hoặc đã xong — bỏ qua
        await publish(rec);
        await tx.execute(sql`
          INSERT INTO krn_outbox_consumed (outbox_id, consumer)
          VALUES (${String(id)}, ${opts.consumer})
          ON CONFLICT (outbox_id, consumer) DO NOTHING`);
        return true;
      });
      if (done) published += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        UPDATE krn_outbox
        SET attempts = attempts + 1,
            last_error = ${message},
            available_at = now() + make_interval(secs => ${backoffMs / 1000})
        WHERE id = ${String(id)}`);
    }
  }

  return { claimed: pending.length, published, failed };
}
