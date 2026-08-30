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
import { APP_ROLE, DISPATCH_ROLE } from "../../src/modules/kernel/index.js";
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
  /**
   * Run a block as the app role with NO `app.team_id` at all — the fail-closed case.
   * A tenant predicate that forgets `NULLIF` turns the unset GUC (an EMPTY STRING, not
   * NULL) into a cast error instead of an empty result, so every tenant-scoped table
   * needs this assertion, not just a "team B sees nothing" one.
   */
  readonly asAppRoleWithoutTenant: <T>(fn: (tx: TkDb) => PromiseLike<T>) => Promise<T>;
  /**
   * Run a block as the dispatch role: no `app.team_id`, because on the claim path the
   * tenant is the ANSWER of the query, not its input. Mirrors `withDispatchRole()`.
   */
  readonly asDispatchRole: <T>(fn: (tx: TkDb) => PromiseLike<T>) => Promise<T>;
  /** One `orc_runs` row for a seeded team; returns its id. */
  readonly seedRun: (team: SeededTeam) => Promise<string>;
  /** One run plus `count` pending `job_runs` rows on it; returns the job ids in order. */
  readonly seedJobs: (team: SeededTeam, count: number) => Promise<readonly string[]>;
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

async function seedRun(raw: PGlite, team: SeededTeam): Promise<string> {
  return insertReturningId(
    raw,
    "orc_runs",
    `INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
     VALUES ($1, $2, 'batch', $3, 'ready') RETURNING id`,
    [team.teamId, team.projectId, team.userId],
  );
}

async function seedJobs(raw: PGlite, team: SeededTeam, count: number): Promise<readonly string[]> {
  const runId = await seedRun(raw, team);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // queue_seq is deliberately left out: its DEFAULT nextval('job_runs_queue_seq') is part
    // of the queue contract, so a fixture that supplied its own value would hide a broken one.
    ids.push(
      await insertReturningId(
        raw,
        "job_runs",
        `INSERT INTO job_runs (team_id, run_id, chain_key) VALUES ($1, $2, $3) RETURNING id`,
        [team.teamId, runId, `chain-${i}`],
      ),
    );
  }
  return ids;
}

export async function makeTestDb(): Promise<TestDb> {
  const raw = await new PGlite();
  const db = drizzle(raw) as unknown as TkDb;
  // Spike: migrate() on PGlite is ~3.6s — so it runs ONLY once per test file
  // (beforeAll); between tests, use reset() (~2ms).
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  /**
   * Shared body of every "run as a non-owner role" helper. `teamId` is the empty string for
   * the roles that must NOT carry a tenant (auth path, dispatch path, fail-closed case) —
   * the same empty string RESET leaves behind, which is why every predicate uses NULLIF.
   */
  const asRole = async <T>(
    role: string,
    teamId: string,
    fn: (tx: TkDb) => PromiseLike<T>,
  ): Promise<T> => {
    await raw.exec(`SET ROLE "${role}"`);
    await raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    try {
      return await fn(db);
    } finally {
      // RESET sets the GUC back to the EMPTY STRING, not NULL — which is exactly why
      // every tenant predicate wraps it in NULLIF.
      await raw.exec(`RESET ROLE`);
      await raw.exec(`RESET app.team_id`);
    }
  };
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
    seedRun: (team: SeededTeam) => seedRun(raw, team),
    seedJobs: (team: SeededTeam, count: number) => seedJobs(raw, team, count),
    asTeam: <T>(teamId: string, fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(APP_ROLE, teamId, fn),
    asAppRoleWithoutTenant: <T>(fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(APP_ROLE, "", fn),
    asDispatchRole: <T>(fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(DISPATCH_ROLE, "", fn),
  };
}
