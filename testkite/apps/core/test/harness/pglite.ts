/**
 * Harness test DB — PGlite in-process.
 *
 * WHY PGlite AND NOT Testcontainers: the sandbox/CI runner does not guarantee a
 * docker daemon (spike 2026-08-27: /var/run/docker.sock does not exist).
 * KNOWN LIMITATION: PGlite has only ONE connection — every transaction queues up
 * sequentially, with NO lock contention. Race/lease/SKIP LOCKED tests must use
 * real Postgres — see test/harness/realpg.ts.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { APP_ROLE } from "../../src/modules/kernel/index.js";
import type { TkDb } from "../../src/modules/kernel/db/types.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** One tenant plus the two ids every tenant-scoped fixture needs: a project and a member. */
export type SeededTeam = {
  readonly teamId: string;
  readonly projectId: string;
  readonly userId: string;
};

export type TestDb = {
  readonly db: TkDb;
  readonly raw: PGlite;
  readonly reset: () => Promise<void>;
  readonly close: () => Promise<void>;
  /**
   * Two fully-formed tenants (org, team, project, user, membership each). Every
   * isolation test starts from here instead of re-inventing its own fixture and
   * quietly disagreeing about the shape. Names/slugs/emails carry a random tag, so
   * calling it twice inside one test file does NOT collide on a unique index.
   */
  readonly seedTwoTeams: () => Promise<readonly [SeededTeam, SeededTeam]>;
  /**
   * Run a block exactly like the real request path does: the non-owner app role plus
   * `app.team_id`. Owner connections bypass RLS (no FORCE ROW LEVEL SECURITY, see
   * drizzle/0002_rls_hardening.sql), so a tenant-isolation assertion made on `t.db`
   * alone proves nothing.
   */
  readonly asTeam: <T>(teamId: string, fn: (tx: TkDb) => PromiseLike<T>) => Promise<T>;
};

async function insertReturningId(
  raw: PGlite,
  what: string,
  query: string,
  params: readonly unknown[],
): Promise<string> {
  const r = await raw.query<{ id: string }>(query, [...params]);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`seedTwoTeams: ${what} INSERT returned no id`);
  return id;
}

async function seedTwoTeams(raw: PGlite): Promise<readonly [SeededTeam, SeededTeam]> {
  const tag = randomUUID().slice(0, 8);
  const orgId = await insertReturningId(
    raw,
    "organizations",
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Org ${tag}`, `org-${tag}`],
  );
  const seedOne = async (label: string): Promise<SeededTeam> => {
    const teamId = await insertReturningId(
      raw,
      "teams",
      `INSERT INTO teams (org_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, `Team ${label}`, `team-${label}-${tag}`],
    );
    const projectId = await insertReturningId(
      raw,
      "projects",
      `INSERT INTO projects (team_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
      [teamId, `Project ${label}`, `project-${label}-${tag}`],
    );
    const userId = await insertReturningId(
      raw,
      "users",
      `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
      [`${label}-${tag}@testkite.test`, `User ${label}`],
    );
    await raw.query(`INSERT INTO memberships (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`, [
      teamId,
      userId,
    ]);
    return { teamId, projectId, userId };
  };
  return [await seedOne("a"), await seedOne("b")] as const;
}

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
    seedTwoTeams: () => seedTwoTeams(raw),
    asTeam: async <T>(teamId: string, fn: (tx: TkDb) => PromiseLike<T>): Promise<T> => {
      await raw.exec(`SET ROLE "${APP_ROLE}"`);
      await raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
      try {
        return await fn(db);
      } finally {
        // RESET sets the GUC back to the EMPTY STRING, not NULL — which is exactly why
        // every tenant predicate wraps it in NULLIF.
        await raw.exec(`RESET ROLE`);
        await raw.exec(`RESET app.team_id`);
      }
    },
  };
}
