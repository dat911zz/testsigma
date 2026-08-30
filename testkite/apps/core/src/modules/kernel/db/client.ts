import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { KernelEnv } from "../env.js";
import type { TkDb } from "./types.js";

export type DbHandle = {
  readonly db: TkDb;
  readonly close: () => Promise<void>;
};

/**
 * MANDATORY on every `pg.Pool` this repo creates.
 *
 * A pool is an EventEmitter, and a connection sitting IDLE in it can still be cut from the
 * SERVER side: a database restart, a failover, a network blip, an admin running
 * `pg_terminate_backend`. pg-pool re-emits that connection's error ON THE POOL from its idle
 * listener — and an EventEmitter with no `error` listener THROWS instead of emitting, which
 * lands as an uncaught exception and kills the whole process (reproduced 2026-08-30 against a
 * real cluster: "Unhandled error event", exit code 1, stack through pg-pool's idleListener).
 *
 * That process also hosts the lease reaper and the outbox relay, so one transient disconnect
 * would mean no job is ever reaped again — the exact total outage M3's reaper exists to
 * prevent. So: LOG, never rethrow. The broken connection has already been evicted from the
 * pool, and the next checkout opens a fresh one; the only thing left to do is make the loss
 * visible instead of silent.
 */
export function attachPoolErrorHandler(pool: pg.Pool): void {
  pool.on("error", (err: Error) => {
    // A BOUNDED shape on purpose: `console.error(err)` on a pg error inspects its `client`
    // property and dumps the whole connection object (tens of KB per event, measured
    // 2026-08-30) — a flapping database would bury the very log line meant to explain it.
    console.error("idle pg client error:", err.stack ?? err.message);
  });
}

export function createDb(env: KernelEnv): DbHandle {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Blueprint §1: Hikari's defaults were one of the contributing causes of the old OOM —
    // every pool limit here is explicit.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  attachPoolErrorHandler(pool);
  return {
    db: drizzle(pool) as unknown as TkDb,
    close: async () => {
      await pool.end();
    },
  };
}
