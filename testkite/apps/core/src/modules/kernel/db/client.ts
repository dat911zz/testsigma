import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { KernelEnv } from "../env.js";
import type { TkDb } from "./types.js";

export type DbHandle = {
  readonly db: TkDb;
  readonly close: () => Promise<void>;
};

export function createDb(env: KernelEnv): DbHandle {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Blueprint §1: Hikari's defaults were one of the contributing causes of the old OOM —
    // every pool limit here is explicit.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return {
    db: drizzle(pool) as unknown as TkDb,
    close: async () => {
      await pool.end();
    },
  };
}
