/**
 * REAL Postgres only: the failure this file guards cannot be staged on PGlite, which has no
 * sockets and no backends to terminate.
 *
 * Scenario, measured on 2026-08-30: a connection is checked out, used, and returned to the pool
 * where it sits IDLE; the server then drops it (`pg_terminate_backend` here — a restart, a
 * failover or a network blip look identical to the client). pg-pool re-emits that error on the
 * pool object. With no `error` listener the EventEmitter rethrows it as an uncaught exception
 * and the process dies with exit code 1, taking the lease reaper and the outbox relay with it.
 * Both pools in this repo — the production one from `createDb()` and the test harness one from
 * `makeRealDb()` — must survive it and keep serving queries.
 */
import { expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { describeRealPg, makeRealDb, realPgUrl } from "../harness/realpg.js";
import { createDb } from "../../src/modules/kernel/db/client.js";
import type { KernelEnv } from "../../src/modules/kernel/env.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const requireUrl = (): string => {
  const url = realPgUrl();
  if (url === undefined) throw new Error("TESTKITE_TEST_PG_URL is not set");
  return url;
};

/** Pool of exactly ONE connection: the connection killed below is the only one the pool holds. */
const envFor = (url: string): KernelEnv => ({
  NODE_ENV: "test",
  PORT: 8080,
  DATABASE_URL: url,
  DATABASE_APP_ROLE: "testkite_app",
  DATABASE_POOL_MAX: 1,
  LOG_LEVEL: "error",
  OIDC_DEV_MOCK: "0",
});

/** Kills one backend from a SEPARATE connection — the same thing an operator or a failover does. */
const terminateBackend = async (url: string, pid: number): Promise<void> => {
  const admin = new pg.Client({ connectionString: url });
  admin.on("error", (err) => {
    console.error("admin client error", err);
  });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
};

/**
 * The pool notices the dead connection asynchronously, so the first query after the kill may
 * still be handed the corpse. Retrying is the honest assertion: the pool must RECOVER, not
 * necessarily recover on the very next statement.
 */
const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      last = err;
      await sleep(50);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
};

describeRealPg("a pooled connection killed from the server side while idle", () => {
  it("does not kill the process and createDb()'s pool serves the next query", async () => {
    const url = requireUrl();
    const handle = createDb(envFor(url));
    try {
      const pidOf = async (): Promise<number> => {
        const res = await handle.db.execute(sql`SELECT pg_backend_pid() AS pid`);
        return Number(res.rows[0]?.["pid"]);
      };
      const victim = await pidOf();
      expect(Number.isInteger(victim)).toBe(true);

      await terminateBackend(url, victim);
      await sleep(200); // let the socket error land on the pool

      const survivor = await withRetry(pidOf);
      expect(survivor).not.toBe(victim);
    } finally {
      await handle.close();
    }
  });

  it("does not kill the process and the real-pg harness pool serves the next query", async () => {
    const url = requireUrl();
    const r = await makeRealDb();
    try {
      const client = await r.pool.connect();
      const victim = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.["pid"]);
      client.release();

      await terminateBackend(url, victim);
      await sleep(200);

      const survivor = await withRetry(async () => {
        const res = await r.pool.query("SELECT pg_backend_pid() AS pid");
        return Number(res.rows[0]?.["pid"]);
      });
      expect(survivor).not.toBe(victim);
    } finally {
      await r.close();
    }
  });
});
