/**
 * REAL Postgres harness — dedicated to tests that need lock contention.
 *
 * WHY NOT USE PGlite HERE: PGlite has only ONE wasm connection; two concurrent transactions
 * just queue sequentially (spike 2026-08-27), so a "SKIP LOCKED disjoint" test
 * on PGlite always passes meaninglessly.
 *
 * Enabled via the TESTKITE_TEST_PG_URL env var. Not set ⇒ skip (a dev machine without
 * Postgres still gets a green `pnpm test`). CI always sets this var — see .github/workflows.
 *
 * Skipping is the RIGHT default and the WRONG one for CI at the same time: on a dev box a
 * missing Postgres must not paint the suite red, but in the `db-tests` job — whose entire
 * reason to exist is that PGlite cannot prove lock contention — a missing URL turns twelve
 * concurrency files into the word "skipped" inside a green report. So the job states its
 * intent with TESTKITE_REQUIRE_PG=1 and `resolveRealPgMode` turns the mismatch into a throw.
 */
import { describe } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { TkDb } from "../../src/modules/kernel/db/types.js";
import { attachPoolErrorHandler } from "../../src/modules/kernel/db/client.js";

const URL_ENV = "TESTKITE_TEST_PG_URL";
const REQUIRE_ENV = "TESTKITE_REQUIRE_PG";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** What the environment says should happen to every `describeRealPg` suite. */
export type RealPgMode = "run" | "skip";

/**
 * PURE, so it can be tested against an environment other than this process's — see
 * realpg-mode.test.ts. An empty URL counts as missing on purpose: `eval "$(test-pg.sh start)"`
 * that printed nothing still exits 0, leaving the variable set but blank.
 */
export function resolveRealPgMode(env: Readonly<Partial<Record<string, string>>>): RealPgMode {
  const url = env[URL_ENV] ?? "";
  if (url !== "") return "run";
  if (env[REQUIRE_ENV] === "1") {
    throw new Error(
      `${REQUIRE_ENV}=1 but ${URL_ENV} is empty: this job exists to run test/concurrency against a REAL Postgres, ` +
        `and skipping those suites would leave a green report that proves nothing about lock contention. ` +
        `Set ${URL_ENV} (CI: the postgres service; locally: eval "$(scripts/test-pg.sh start)"), or unset ${REQUIRE_ENV} to allow the skip.`,
    );
  }
  return "skip";
}

export const realPgUrl = (): string | undefined => {
  const url = process.env[URL_ENV];
  return url === undefined || url === "" ? undefined : url;
};

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
export const describeRealPg = describe.skipIf(resolveRealPgMode(process.env) === "skip");

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
