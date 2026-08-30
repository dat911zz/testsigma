/**
 * REAL Postgres harness — dedicated to tests that need lock contention.
 *
 * WHY NOT USE PGlite HERE: PGlite has only ONE wasm connection; two concurrent transactions
 * just queue sequentially (spike 2026-08-27), so a "SKIP LOCKED disjoint" test
 * on PGlite always passes meaninglessly.
 *
 * Enabled via the TESTKITE_TEST_PG_URL env var. Not set ⇒ skip (a dev machine without
 * Postgres still gets a green `pnpm test`). CI always sets this var — see .github/workflows.
 */
import { describe } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { TkDb } from "../../src/modules/kernel/db/types.js";
import { attachPoolErrorHandler } from "../../src/modules/kernel/db/client.js";

const URL_ENV = "TESTKITE_TEST_PG_URL";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export const realPgUrl = (): string | undefined => process.env[URL_ENV];

/**
 * `describe` already has the skip condition attached. The condition is fixed AT IMPORT TIME —
 * vitest needs to know whether the suite runs right at the collect phase.
 *
 * Deliberate deviation from the block in the plan: dropped the annotation
 * `typeof describe.skipIf extends never ? never : typeof describe` along with the
 * `as unknown as typeof describe` cast. vitest 3's `describe.skipIf()` already returns
 * `ChainableSuiteAPI` — callable as `(name, factory)` exactly like `describe` — so that cast
 * pair was a cast without justification, which TestKite's code standard bans. The inferred type is correct and stricter.
 */
export const describeRealPg = describe.skipIf(realPgUrl() === undefined);

export type RealDb = {
  readonly db: TkDb;
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
};

export async function makeRealDb(): Promise<RealDb> {
  const connectionString = realPgUrl();
  if (connectionString === undefined) throw new Error(`${URL_ENV} is not set`);
  const pool = new pg.Pool({ connectionString, max: 8 });
  // Same reason as production (see attachPoolErrorHandler): a backend dying while its
  // connection is idle in this pool would otherwise take the whole vitest worker down with an
  // "Unhandled error event" and report as an unrelated suite failure.
  attachPoolErrorHandler(pool);
  // Cast like the PGlite harness: `TkDb` is intentionally driver-agnostic (`PgQueryResultHKT` isn't
  // bound to a driver yet), so `NodePgDatabase` isn't directly assignable; migrate() also expects
  // the real driver-bound database type.
  const db = drizzle(pool) as unknown as TkDb;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
