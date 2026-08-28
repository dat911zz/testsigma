/**
 * Harness test DB — PGlite in-process.
 *
 * WHY PGlite AND NOT Testcontainers: the sandbox/CI runner does not guarantee a
 * docker daemon (spike 2026-08-27: /var/run/docker.sock does not exist).
 * KNOWN LIMITATION: PGlite has only ONE connection — every transaction queues up
 * sequentially, with NO lock contention. Race/lease/SKIP LOCKED tests must use
 * real Postgres — see test/harness/realpg.ts.
 */
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { TkDb } from "../../src/modules/kernel/db/types.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type TestDb = {
  readonly db: TkDb;
  readonly raw: PGlite;
  readonly reset: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export async function makeTestDb(): Promise<TestDb> {
  const raw = await new PGlite();
  const db = drizzle(raw) as unknown as TkDb;
  // Spike: migrate() on PGlite is ~3.6s — so it runs ONLY once per test file
  // (beforeAll); between tests, use reset() (~2ms).
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    raw,
    // Spike: TRUNCATE ~2ms vs new PGlite() ~2.3s — always reset, never rebuild.
    reset: async () => {
      const r = await raw.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'`,
      );
      if (r.rows.length === 0) return;
      const names = r.rows.map((x) => `"${x.t}"`).join(", ");
      await raw.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    },
    close: async () => {
      await raw.close();
    },
  };
}
