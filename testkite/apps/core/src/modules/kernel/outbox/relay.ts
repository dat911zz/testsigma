import { sql } from "drizzle-orm";
import { isSqlRow, rowsOf, type SqlRow } from "../db/rows.js";
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

/** `krn_outbox.id` is bigserial — the driver returns string (pg) or number/bigint (PGlite). */
function readId(row: SqlRow): bigint {
  const raw = row["id"];
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "string" || typeof raw === "number") return BigInt(raw);
  throw new Error(`relay: could not read krn_outbox.id (typeof=${typeof raw})`);
}

function toOutboxRecord(row: Record<string, unknown>, id: bigint): OutboxRecord {
  const payload = row["payload"];
  if (!isSqlRow(payload)) {
    // Poison message: the writer always writes an object. Throwing here ⇒ the event counts
    // as failed, attempts increments, and it eventually falls out of the batch via maxAttempts — the relay never gets stuck.
    throw new Error(`relay: payload of event ${String(id)} is not a JSON object`);
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
 * One relay round. Each event is its OWN transaction:
 *   BEGIN → SELECT ... FOR UPDATE SKIP LOCKED (hold the row lock)
 *         → publish (the ONE side-effect, inside the lock)
 *         → INSERT consumed ... ON CONFLICT DO NOTHING → COMMIT
 * If publish throws ⇒ ROLLBACK the marking part, write attempts/last_error/available_at in a
 * separate transaction ⇒ at-least-once, no event is lost, and no event blocks another.
 *
 * This is a SKELETON: `publish` is injected from outside. Kernel does not import bullmq (lint rule) —
 * wiring in the real BullMQ is M3's job.
 *
 * `claimed` is the row count the SELECT returns; `published + failed` can be SMALLER when another
 * relay is already holding the row's lock (SKIP LOCKED skips it, doesn't wait) or has already
 * consumed that row (NOT EXISTS in the locking query) — that difference is work that belongs to
 * the other instance, not an error.
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
    // `id` is read INSIDE the try: a row whose id can't be parsed is exactly the kind of
    // single-event failure this loop's invariant (see doc-comment above) promises never
    // blocks the rest of the batch. Parsing it outside the try would let that one row's
    // error escape runRelayOnce entirely instead of just counting toward `failed`.
    let id: bigint | undefined;
    try {
      id = readId(row);
      const rec = toOutboxRecord(row, id);
      const done = await db.transaction(async (tx): Promise<boolean> => {
        // TWO statements, in this order, and they must NOT be merged back into one.
        //
        // 1. Take the row lock. SKIP LOCKED so a second relay moves on to another row instead
        //    of queueing up to wait.
        const locked = rowsOf(
          await tx.execute(sql`
            SELECT o.id FROM krn_outbox o
            WHERE o.id = ${String(id)}
            FOR UPDATE SKIP LOCKED`),
        );
        if (locked.length === 0) return false; // another relay is holding it right now — skip
        // 2. ONLY NOW ask whether it was already consumed. The candidate list was fixed BEFORE
        //    any transaction, so it is an OLD snapshot: another relay on the same consumer may
        //    have published this row, COMMITted `consumed` and RELEASED the lock while we were
        //    working through earlier rows.
        //
        //    Merging this check into the locking statement above (as this code did until
        //    2026-08-30) publishes that row a SECOND time, and measured on PostgreSQL 16.13 it
        //    really does: under READ COMMITTED a statement's snapshot is taken when the
        //    statement STARTS, but its row lock is acquired after the qual has been evaluated.
        //    A competing relay that commits in between is therefore invisible to the NOT EXISTS
        //    while its lock is already gone — proven with `pg_sleep` inside the qual: the merged
        //    form returns the row, the split form returns nothing.
        //
        //    Split, the check is safe: publishing requires holding this lock, and every relay
        //    that held it committed `consumed` before releasing it, so a snapshot taken AFTER
        //    the lock was granted sees that commit.
        const consumed = rowsOf(
          await tx.execute(sql`
            SELECT 1 AS hit FROM krn_outbox_consumed
            WHERE outbox_id = ${String(id)} AND consumer = ${opts.consumer}`),
        );
        if (consumed.length > 0) return false; // another relay already finished it — skip
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
      // `id` can still be undefined here if `readId(row)` itself threw: there is then no
      // key to mark on krn_outbox, so skip the UPDATE — the row stays as-is and is
      // re-claimed (and re-fails the same way) on the next round rather than crashing.
      if (id !== undefined) {
        const message = err instanceof Error ? err.message : String(err);
        await db.execute(sql`
          UPDATE krn_outbox
          SET attempts = attempts + 1,
              last_error = ${message},
              available_at = now() + make_interval(secs => ${backoffMs / 1000})
          WHERE id = ${String(id)}`);
      }
    }
  }

  return { claimed: pending.length, published, failed };
}
