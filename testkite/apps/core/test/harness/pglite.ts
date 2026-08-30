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
import type { StepInputDto } from "@testkite/contract";
import { APP_ROLE, AUTH_ROLE, DISPATCH_ROLE, withTenant } from "../../src/modules/kernel/index.js";
import type { TenantContext, TkDb, TkTx } from "../../src/modules/kernel/db/types.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/index.js";
import {
  claimJobs,
  dispatchPending,
  type ClaimedJobRow,
} from "../../src/modules/orchestration/queue/job-queue.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * The element id `seedCaseWithPendingLocator` puts on its only step. The elements module
 * does not land before M4, so at phase 0 the element loader is an INJECTION PORT and the
 * test's own `loadElements` decides what an element looks like: recognising this id and
 * answering "no locator captured yet" is what makes the compiler raise
 * `element_pending_locator` rather than `element_not_found`.
 */
export const PENDING_LOCATOR_ELEMENT_ID = "00000000-0000-4000-8000-00000000dead";

/** Base URL of the environment every seeded project gets — phase 0 refuses a project without one. */
export const SEEDED_BASE_URL = "https://app.testkite.test";

/** One tenant plus the two ids every tenant-scoped fixture needs: a project and a member. */
export type SeededTeam = {
  readonly teamId: string;
  readonly projectId: string;
  readonly userId: string;
};

/** The three ids a result fixture hands back: results are keyed by run, written per job. */
export type SeededCaseResult = {
  readonly runId: string;
  readonly jobRunId: string;
  readonly caseResultId: string;
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
   * Run a service function exactly the way a request does: inside `withTenant()` (its own
   * transaction, `SET LOCAL ROLE`, `set_config('app.team_id', …, true)`) and with the
   * matching `TenantContext` handed in. `asTeam` above is the raw-SQL sibling — use it to
   * ASSERT what a tenant can see; use this one to CALL the code under test, so the L1
   * fail-closed check in the service runs for real instead of being bypassed.
   */
  readonly asTeamCtx: <T>(
    teamId: string,
    fn: (tx: TkTx, ctx: TenantContext) => Promise<T>,
  ) => Promise<T>;
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
  /**
   * Run a block as the auth role: no `app.team_id`, because the tenant is what a credential
   * lookup ANSWERS. Mirrors `withAuthRole()` — the role that may only SELECT the two tables
   * the authentication path reads.
   */
  readonly asAuthRole: <T>(fn: (tx: TkDb) => PromiseLike<T>) => Promise<T>;
  /** Row count of one table, read on the owner connection (RLS-free) — a fixture, not a subject. */
  readonly countRows: (table: string) => Promise<number>;
  /**
   * Every row of one table, verbatim, on the owner connection. For assertions ABOUT THE
   * STORAGE ITSELF ("this column never holds the secret"), which a tenant-scoped read could
   * not make: RLS would hide the very row the test is trying to inspect.
   */
  readonly dumpTable: (table: string) => Promise<readonly Record<string, unknown>[]>;
  /** Flips the drain flag the fleet heartbeat answers with — the operator action, without an operator. */
  readonly setWorkerDrain: (workerId: string, drain: boolean) => Promise<void>;
  /**
   * One job taken all the way to `running` through the REAL queue path (dispatch + claim), so
   * `attempt`/`lease_epoch` are what a worker would actually be holding. Anything minting a
   * run token needs a job row that exists, since orc_run_tokens carries a composite FK to it.
   */
  readonly seedClaimedJob: (team: SeededTeam) => Promise<ClaimedJobRow>;
  /** One `orc_runs` row for a seeded team; returns its id. */
  readonly seedRun: (team: SeededTeam) => Promise<string>;
  /**
   * One run plus `count` pending `job_runs` rows on it; returns the job ids in order.
   * `chainKeys` names them, so a test that asserts on QUEUE ORDER can read the order it
   * expects instead of mapping ids back to positions by hand.
   */
  readonly seedJobs: (
    team: SeededTeam,
    count: number,
    chainKeys?: readonly string[],
  ) => Promise<readonly string[]>;
  /**
   * Same as `seedJobs`, but also hands back the run those jobs hang off. A result row is keyed
   * by RUN (that is what `latestCaseResults` reads), so a results test needs the run id that
   * `seedJobs` keeps to itself.
   */
  readonly seedRunWithJobs: (
    team: SeededTeam,
    count: number,
    chainKeys?: readonly string[],
  ) => Promise<{ readonly runId: string; readonly jobIds: readonly string[] }>;
  /**
   * One `res_case_results` row landing on `startedAt` — the partition key. Written on the OWNER
   * connection on purpose: these are the tests whose subject is the STORAGE (which partition a
   * row lands in, what a child GRANT would leak), so the fixture must not itself depend on the
   * tenant path it is being used to inspect.
   */
  readonly seedCaseResult: (team: SeededTeam, startedAt: Date) => Promise<SeededCaseResult>;
  /**
   * Moves a job's `heartbeat_at` `seconds` into the past — the only way to reach the
   * reaper's thresholds without making the test sleep for half a minute. `lease_expires_at`
   * is left ALONE on purpose: the reaper is specified to read `heartbeat_at`, so an
   * implementation that watched the lease deadline instead must go red here.
   */
  readonly ageHeartbeat: (jobRunId: string, seconds: number) => Promise<void>;
  /** Rewrites `attempt` on every job of a team — the shortcut to "one attempt left". */
  readonly setAttempt: (teamId: string, attempt: number) => Promise<void>;
  /**
   * Hands every QUEUED job of a team to a worker that then died: `running`, with a heartbeat
   * far past the reaper's dead threshold. The shortcut for a test whose subject is the SWEEP
   * rather than the claim path — `dispatchPending` + `claimJobs` + `ageHeartbeat` would say
   * the same thing in four statements.
   */
  readonly markRunningWithDeadHeartbeat: (teamId: string) => Promise<void>;
  /**
   * Expires the dispatcher lease as if its holder had stopped renewing. Writes only
   * `expires_at`, so `holder`/`epoch` still name the leader a challenger has to take over
   * FROM — which is what makes it usable as the dead-man fixture.
   */
  readonly expireLease: () => Promise<void>;
  /**
   * Takes a job away from whoever holds it, the way the reaper will (M3 Task 6): one
   * `lease_epoch` bump, status untouched. Runs as the OWNER connection on purpose — this is
   * the fixture standing in for a component that does not exist yet, not a code path under
   * test. Returns the new epoch.
   */
  readonly bumpEpoch: (teamId: string, jobRunId: string) => Promise<number>;
  /**
   * `count` independent cases that COMPILE — real verbs from the registry, an element on
   * every action step, a nested `if` block, and the environment phase 0 needs. Each one is
   * its own chain, so a run over the returned ids yields exactly `count` jobs; pass
   * `prereqCaseId` to hang them off an existing case instead, which makes ONE longer chain.
   */
  readonly seedRunnableCases: (
    team: SeededTeam,
    count: number,
    opts?: { readonly prereqCaseId?: string },
  ) => Promise<readonly string[]>;
  /**
   * One case whose only step points at `PENDING_LOCATOR_ELEMENT_ID` — the shape that makes
   * the compiler stop with `element_pending_locator` and no plan at all.
   */
  readonly seedCaseWithPendingLocator: (team: SeededTeam) => Promise<string>;
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
    // Default quota limits, exactly like seedQuotaDefaults() does on the real onboarding
    // path. Without the row a team is "never onboarded" and every quota reservation is
    // refused, which would make anything downstream of phase 0 fail for a reason that has
    // nothing to do with what the test is about.
    await raw.query(`INSERT INTO quota_limits (team_id) VALUES ($1)`, [teamId]);
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

async function seedRunWithJobs(
  raw: PGlite,
  team: SeededTeam,
  count: number,
  chainKeys?: readonly string[],
): Promise<{ readonly runId: string; readonly jobIds: readonly string[] }> {
  const runId = await seedRun(raw, team);
  const jobIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // queue_seq is deliberately left out: its DEFAULT nextval('job_runs_queue_seq') is part
    // of the queue contract, so a fixture that supplied its own value would hide a broken one.
    jobIds.push(
      await insertReturningId(
        raw,
        "job_runs",
        `INSERT INTO job_runs (team_id, run_id, chain_key) VALUES ($1, $2, $3) RETURNING id`,
        [team.teamId, runId, chainKeys?.[i] ?? `chain-${i}`],
      ),
    );
  }
  return { runId, jobIds };
}

async function seedJobs(
  raw: PGlite,
  team: SeededTeam,
  count: number,
  chainKeys?: readonly string[],
): Promise<readonly string[]> {
  return (await seedRunWithJobs(raw, team, count, chainKeys)).jobIds;
}

async function seedCaseResult(
  raw: PGlite,
  team: SeededTeam,
  startedAt: Date,
): Promise<SeededCaseResult> {
  const { runId, jobIds } = await seedRunWithJobs(raw, team, 1);
  const jobRunId = jobIds[0];
  if (jobRunId === undefined) throw new Error("seedCaseResult: seedRunWithJobs returned no job");
  // ISO 8601, not the Date object: the driver's own timestamp encoding is not the subject of
  // any test here, and an ISO string is what timestamptz parses without ambiguity.
  const caseResultId = await insertReturningId(
    raw,
    "res_case_results",
    `INSERT INTO res_case_results
       (team_id, run_id, job_run_id, case_id, chain_key, verdict, started_at, finished_at)
     VALUES ($1, $2, $3, gen_random_uuid(), 'chain-0', 'passed', $4, $4) RETURNING id`,
    [team.teamId, runId, jobRunId, startedAt.toISOString()],
  );
  return { runId, jobRunId, caseResultId };
}

/**
 * Table names reach SQL as identifiers, which cannot be parameterised — so the harness only
 * ever accepts a plain lowercase identifier and refuses anything else, instead of trusting
 * every future caller to pass a literal.
 */
function assertTableName(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`unsafe table name: ${table}`);
  return table;
}

async function countRows(raw: PGlite, table: string): Promise<number> {
  const r = await raw.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "${assertTableName(table)}"`,
  );
  return r.rows[0]?.n ?? 0;
}

async function dumpTable(raw: PGlite, table: string): Promise<readonly Record<string, unknown>[]> {
  const r = await raw.query<Record<string, unknown>>(`SELECT * FROM "${assertTableName(table)}"`);
  return r.rows;
}

async function setWorkerDrain(raw: PGlite, workerId: string, drain: boolean): Promise<void> {
  const r = await raw.query(`UPDATE orc_workers SET drain = $2 WHERE id = $1 RETURNING id`, [
    workerId,
    drain,
  ]);
  if (r.rows.length === 0) throw new Error(`setWorkerDrain: no orc_workers row ${workerId}`);
}

async function seedClaimedJob(
  db: TkDb,
  raw: PGlite,
  team: SeededTeam,
): Promise<ClaimedJobRow> {
  await seedJobs(raw, team, 1);
  await dispatchPending(db, { limit: 1 });
  const claimed = await claimJobs(db, { workerId: "seed-worker", lane: "batch", max: 1 });
  const job = claimed[0];
  if (job === undefined) throw new Error("seedClaimedJob: the job it had just seeded was not claimable");
  return job;
}

async function ageHeartbeat(raw: PGlite, jobRunId: string, seconds: number): Promise<void> {
  const r = await raw.query(
    `UPDATE job_runs SET heartbeat_at = now() - make_interval(secs => $2::double precision)
      WHERE id = $1 RETURNING id`,
    [jobRunId, seconds],
  );
  if (r.rows.length === 0) throw new Error(`ageHeartbeat: no job_runs row ${jobRunId}`);
}

async function setAttempt(raw: PGlite, teamId: string, attempt: number): Promise<void> {
  const r = await raw.query(`UPDATE job_runs SET attempt = $2 WHERE team_id = $1 RETURNING id`, [
    teamId,
    attempt,
  ]);
  if (r.rows.length === 0) throw new Error(`setAttempt: team ${teamId} has no job_runs row`);
}

/** Four times the reaper's 30s dead threshold: nothing about this heartbeat is borderline. */
const DEAD_HEARTBEAT_SECONDS = 120;

async function markRunningWithDeadHeartbeat(raw: PGlite, teamId: string): Promise<void> {
  const r = await raw.query(
    `UPDATE job_runs
        SET status = 'running',
            worker_id = 'dead-worker',
            started_at = COALESCE(started_at, now()),
            lease_expires_at = now(),
            heartbeat_at = now() - make_interval(secs => $2::double precision)
      WHERE team_id = $1 AND status IN ('pending', 'dispatched')
     RETURNING id`,
    [teamId, DEAD_HEARTBEAT_SECONDS],
  );
  if (r.rows.length === 0) {
    throw new Error(`markRunningWithDeadHeartbeat: team ${teamId} has no queued job_runs row`);
  }
}

async function expireLease(raw: PGlite): Promise<void> {
  const r = await raw.query(
    `UPDATE orc_dispatcher_lease SET expires_at = now() - interval '1 second' RETURNING id`,
  );
  if (r.rows.length === 0) throw new Error("expireLease: nobody holds the dispatcher lease");
}

async function bumpEpoch(raw: PGlite, teamId: string, jobRunId: string): Promise<number> {
  const r = await raw.query<{ lease_epoch: number }>(
    `UPDATE job_runs SET lease_epoch = lease_epoch + 1
      WHERE team_id = $1 AND id = $2 RETURNING lease_epoch`,
    [teamId, jobRunId],
  );
  const epoch = r.rows[0]?.lease_epoch;
  if (epoch === undefined) throw new Error("bumpEpoch: no job_runs row matched");
  return epoch;
}

/**
 * The environment phase 0 loads for a project. Idempotent, because a test may seed cases
 * more than once for the same team and the project only ever has the one dev environment.
 */
async function ensureEnvironment(raw: PGlite, team: SeededTeam): Promise<void> {
  await raw.query(
    `INSERT INTO pln_environments (team_id, project_id, name, base_url, status)
     VALUES ($1, $2, 'dev', $3, 'active')
     ON CONFLICT (team_id, project_id, name) DO NOTHING`,
    [team.teamId, team.projectId, SEEDED_BASE_URL],
  );
}

/** A case written through the REAL authoring path, so its revision payload is the real shape. */
async function seedCase(
  db: TkDb,
  team: SeededTeam,
  name: string,
  steps: readonly StepInputDto[],
  prereqCaseId?: string,
): Promise<string> {
  const ctx: TenantContext = { teamId: team.teamId };
  const actor = { userId: team.userId };
  const created = await withTenant(db, ctx, (tx) =>
    createCase(tx, ctx, actor, {
      projectId: team.projectId,
      name,
      isStepGroup: false,
      ...(prereqCaseId === undefined ? {} : { prereqCaseId }),
    }),
  );
  await withTenant(db, ctx, (tx) =>
    replaceSteps(tx, ctx, actor, { caseId: created.id, expectedVersion: created.version, steps }),
  );
  return created.id;
}

async function seedRunnableCases(
  db: TkDb,
  raw: PGlite,
  team: SeededTeam,
  count: number,
  opts?: { readonly prereqCaseId?: string },
): Promise<readonly string[]> {
  await ensureEnvironment(raw, team);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(
      // Element ids are random per case: a chain must never share an element with another
      // chain by accident, or a single broken element would make two chains fail together.
      // The `if` block is not decoration — a flat list of action steps would never exercise
      // the step TREE on the way from the authoring payload to the compiler.
      await seedCase(
        db,
        team,
        `Runnable ${String(i)} ${randomUUID().slice(0, 8)}`,
        [
          {
            kind: "action",
            renderedSentence: "Enter the QA account in the email field",
            verbOpKey: "web.enter",
            args: { value: "qa@testkite.test" },
            elementId: randomUUID(),
          },
          {
            kind: "if",
            renderedSentence: "If the sign-in form is shown",
            conditionExpected: ["SUCCESS"],
            children: [
              {
                kind: "action",
                renderedSentence: "Click on the sign-in button",
                verbOpKey: "web.click",
                elementId: randomUUID(),
              },
            ],
          },
        ],
        opts?.prereqCaseId,
      ),
    );
  }
  return ids;
}

async function seedCaseWithPendingLocator(
  db: TkDb,
  raw: PGlite,
  team: SeededTeam,
): Promise<string> {
  await ensureEnvironment(raw, team);
  return seedCase(db, team, `Pending locator ${randomUUID().slice(0, 8)}`, [
    {
      kind: "action",
      renderedSentence: "Click on the checkout button",
      verbOpKey: "web.click",
      elementId: PENDING_LOCATOR_ELEMENT_ID,
    },
  ]);
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
    countRows: (table: string) => countRows(raw, table),
    dumpTable: (table: string) => dumpTable(raw, table),
    setWorkerDrain: (workerId: string, drain: boolean) => setWorkerDrain(raw, workerId, drain),
    seedClaimedJob: (team: SeededTeam) => seedClaimedJob(db, raw, team),
    seedJobs: (team: SeededTeam, count: number, chainKeys?: readonly string[]) =>
      seedJobs(raw, team, count, chainKeys),
    seedRunWithJobs: (team: SeededTeam, count: number, chainKeys?: readonly string[]) =>
      seedRunWithJobs(raw, team, count, chainKeys),
    seedCaseResult: (team: SeededTeam, startedAt: Date) => seedCaseResult(raw, team, startedAt),
    ageHeartbeat: (jobRunId: string, seconds: number) => ageHeartbeat(raw, jobRunId, seconds),
    setAttempt: (teamId: string, attempt: number) => setAttempt(raw, teamId, attempt),
    markRunningWithDeadHeartbeat: (teamId: string) => markRunningWithDeadHeartbeat(raw, teamId),
    expireLease: () => expireLease(raw),
    bumpEpoch: (teamId: string, jobRunId: string) => bumpEpoch(raw, teamId, jobRunId),
    seedRunnableCases: (team: SeededTeam, count: number, opts?: { readonly prereqCaseId?: string }) =>
      seedRunnableCases(db, raw, team, count, opts),
    seedCaseWithPendingLocator: (team: SeededTeam) => seedCaseWithPendingLocator(db, raw, team),
    asTeam: <T>(teamId: string, fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(APP_ROLE, teamId, fn),
    asTeamCtx: <T>(teamId: string, fn: (tx: TkTx, ctx: TenantContext) => Promise<T>): Promise<T> =>
      withTenant(db, { teamId }, (tx) => fn(tx, { teamId })),
    asAppRoleWithoutTenant: <T>(fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(APP_ROLE, "", fn),
    asDispatchRole: <T>(fn: (tx: TkDb) => PromiseLike<T>): Promise<T> =>
      asRole(DISPATCH_ROLE, "", fn),
    asAuthRole: <T>(fn: (tx: TkDb) => PromiseLike<T>): Promise<T> => asRole(AUTH_ROLE, "", fn),
  };
}
