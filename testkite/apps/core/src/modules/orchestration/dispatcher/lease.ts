/**
 * Dispatcher leader election, fenced by (holder, epoch).
 *
 * Parameters are the ones the 2026-08-29 spike settled on: TTL 10s, renewed every 10th tick
 * of the 250ms dispatcher loop (= 2.5s), candidates probing on the same 250ms tick. Failover
 * therefore tracks the TTL (measured 5032ms at TTL=5s), far under the blueprint's 120s
 * "fall back to plain FIFO" threshold, and — unlike an advisory lock — it is the SAME bound
 * whether the leader crashed, was SIGKILLed, or vanished behind a network partition.
 *
 * Losing an election is NOT an error: `null` means "somebody else leads, try again next
 * tick". Callers must never turn it into a throw, or every follower would log a stack trace
 * four times a second.
 */
import { sql } from "drizzle-orm";
import { firstRow, withDispatchRole, type TkDb } from "../../kernel/index.js";

export const LEASE_TTL_SECONDS = 10;
/** Dispatcher ticks are 250ms, so renewing every 10th tick = every 2.5s = TTL/4. */
export const LEASE_RENEW_EVERY_TICKS = 10;

export interface DispatcherLease {
  readonly holder: string;
  readonly epoch: number;
  readonly expiresAt: Date;
}

/** Same reasoning as job-queue's: both drivers hand back a `Date`, a third one must not silently lose the ms. */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toLease(row: Record<string, unknown>): DispatcherLease {
  return {
    holder: String(row["holder"]),
    epoch: Number(row["epoch"]),
    expiresAt: toDate(row["expires_at"]),
  };
}

/**
 * Acquire OR renew in one statement. The ON CONFLICT ... WHERE clause is the whole election:
 *   holder = me            -> renew (epoch unchanged, acquired_at unchanged)
 *   expires_at < now()     -> take over (epoch + 1, acquired_at = now)
 *   otherwise              -> 0 rows, someone else leads
 *
 * `holder` MUST be unique per LIVE PROCESS — it is the entire identity, there is no session or
 * pid behind it. Two processes sharing one string both match the first branch, so both are
 * told they lead, on every tick, with an epoch that never moves: a permanent split-brain, not
 * a takeover window. Use `defaultDispatcherId()` / `env.DISPATCHER_ID` (kernel/env.ts), which
 * carries the pid for exactly this reason; the collision is characterised on real Postgres in
 * test/concurrency/dispatcher-leader.test.ts.
 *
 * One statement is safe HERE, unlike the read-then-write shapes elsewhere in this module:
 * `INSERT ... ON CONFLICT DO UPDATE` locks the conflicting row FIRST and only then evaluates
 * its WHERE against the latest committed version of that row. A concurrent takeover that
 * commits mid-flight is therefore seen, not skipped — the failure mode that forced the relay
 * outbox to split its lock and its predicate into two statements. Measured: five candidates
 * firing together elect exactly one leader (test/concurrency/dispatcher-leader.test.ts).
 *
 * Everything is compared against the DATABASE clock: a leader whose host clock has drifted
 * can neither extend its own deadline nor declare a healthy leader expired.
 */
export async function acquireOrRenewLease(
  db: TkDb,
  input: { readonly holder: string; readonly ttlSeconds?: number },
): Promise<DispatcherLease | null> {
  const ttl = input.ttlSeconds ?? LEASE_TTL_SECONDS;
  return withDispatchRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        INSERT INTO orc_dispatcher_lease (id, holder, epoch, expires_at, last_tick_at)
        VALUES (1, ${input.holder}, 1,
                now() + make_interval(secs => ${ttl}::double precision), now())
        ON CONFLICT (id) DO UPDATE SET
          holder = ${input.holder},
          epoch = CASE WHEN orc_dispatcher_lease.holder = ${input.holder}
                       THEN orc_dispatcher_lease.epoch ELSE orc_dispatcher_lease.epoch + 1 END,
          acquired_at = CASE WHEN orc_dispatcher_lease.holder = ${input.holder}
                             THEN orc_dispatcher_lease.acquired_at ELSE now() END,
          last_tick_at = now(),
          expires_at = now() + make_interval(secs => ${ttl}::double precision)
        WHERE orc_dispatcher_lease.holder = ${input.holder}
           OR orc_dispatcher_lease.expires_at < now()
        RETURNING holder, epoch, expires_at`),
    );
    return row === undefined ? null : toLease(row);
  });
}

/**
 * Graceful shutdown: expire the lease NOW instead of making the next dispatcher wait out the
 * TTL. Fenced by (holder, epoch) so a leader that was already replaced — the exact zombie the
 * epoch exists for — cannot free its successor's lease on its way out.
 */
export async function releaseLease(
  db: TkDb,
  input: { readonly holder: string; readonly epoch: number },
): Promise<void> {
  await withDispatchRole(db, (tx) =>
    tx.execute(sql`
      UPDATE orc_dispatcher_lease SET expires_at = now() - interval '1 second'
       WHERE id = 1 AND holder = ${input.holder} AND epoch = ${input.epoch}`),
  );
}

/**
 * What the dead-man alert reads. `stale = true` means nobody has ticked within the TTL, i.e.
 * the fleet currently has NO dispatcher — one `SELECT`, with a name and a timestamp attached,
 * which is precisely what pg_locks could never have told us.
 *
 * `null` = nobody has ever led (a cold cluster), which is not the same thing as a dead leader
 * and must not page anyone on its own.
 */
export async function readLease(
  db: TkDb,
): Promise<(DispatcherLease & { readonly lastTickAt: Date | null; readonly stale: boolean }) | null> {
  return withDispatchRole(db, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        SELECT holder, epoch, expires_at, last_tick_at, (expires_at < now()) AS stale
          FROM orc_dispatcher_lease WHERE id = 1`),
    );
    if (row === undefined) return null;
    const tick = row["last_tick_at"];
    return {
      ...toLease(row),
      lastTickAt: tick === null || tick === undefined ? null : toDate(tick),
      stale: row["stale"] === true,
    };
  });
}
