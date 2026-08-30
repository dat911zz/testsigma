/**
 * Fleet infrastructure tables. Part 1 of 3: `orc_dispatcher_lease` — leadership as a ROW, on
 * purpose. `orc_workers` / `orc_run_tokens` / `orc_run_events` join this file in Task 9.
 *
 * Why not pg_advisory_lock (spike 2026-08-29 §3, numbers measured in this sandbox):
 *  - invisible: pg_locks cannot say WHO holds it, since when, or when it last ticked, and the
 *    blueprint's §5 observability list demands a "dispatcher dead-man" alert;
 *  - unbounded worst case: a network-partitioned leader keeps the lock until TCP keepalive
 *    kills the session — the server default here is 7200s idle + 9x75s = ~2h07 with no
 *    dispatcher, and on a managed Postgres those are not always ours to change;
 *  - it leaks through a connection pool: measured that pg.Pool handed back the SAME session
 *    after release() and pg_try_advisory_lock succeeded a second time, so two processes both
 *    believed they led, with no signal anywhere.
 * A TTL row costs one UPDATE every 2.5s and fails over in ~TTL (measured 5032ms at TTL=5s).
 * Leadership is only an OPTIMISATION here — dispatch itself is already safe under split brain
 * thanks to SKIP LOCKED plus the conditional epoch UPDATE — so trading a ~TTL failover for a
 * bounded worst case and a readable row is the right side of the deal.
 *
 * There is exactly ONE row, forever: `id smallint PRIMARY KEY` with a CHECK pinning it to 1.
 * This table is NOT tenant-scoped and carries NO RLS — it is fleet infrastructure, and the
 * migration grants it to `testkite_dispatch` alone (the request-path role gets nothing, so a
 * leaked app connection cannot even read who leads, let alone appoint itself).
 */
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

export const orcDispatcherLease = pgTable(
  "orc_dispatcher_lease",
  {
    id: smallint("id").primaryKey().default(1),
    holder: text("holder").notNull(),
    /** Bumped ONLY on takeover, never on renew — a stable epoch means "still the same leader". */
    epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
    /** When the CURRENT leader took over. Untouched by a renew, so it reads as leader uptime. */
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("orc_dispatcher_lease_singleton", sql`${t.id} = 1`)],
);
