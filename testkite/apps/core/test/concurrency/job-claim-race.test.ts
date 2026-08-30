/**
 * The CONCURRENCY layer of the queue of record — runs ONLY on REAL Postgres.
 *
 * WHY IT CANNOT LIVE ON PGlite: PGlite is a SINGLE wasm connection, so two "concurrent"
 * transactions merely queue up and `FOR UPDATE SKIP LOCKED` never has anything to skip — a
 * disjointness assertion made there is a FALSE GREEN (see test/harness/realpg.ts). The whole
 * safety argument of `claimJobs` is that the DATABASE, not the code, guarantees no job is
 * handed to two workers; that argument only means something with several real connections
 * hitting the same rows.
 *
 * Two regressions this file exists to catch, both invisible to the PGlite layer:
 *  1. dropping `SKIP LOCKED` (or the `FOR UPDATE` altogether) from the candidate CTE ⇒ two
 *     workers claim the same chain ⇒ it runs twice, bills twice, and reports two verdicts;
 *  2. splitting claim into a SELECT then a separate UPDATE ⇒ the same double-claim through a
 *     wider window.
 *
 * Every race is preceded by `warmPool`: on a cold pool `Promise.all` is not parallel at all —
 * the second caller has to open a physical connection (TCP + auth) and only gets to the table
 * once the first has COMMITted, which is the false green documented in promote-lock.test.ts.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is
 * collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { claimJobs, dispatchPending } from "../../src/modules/orchestration/queue/job-queue.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;

/** Opens `n` physical connections BEFORE the race, so `Promise.all` is parallel from the first ms. */
async function warmPool(pool: RealDb["pool"], n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

describeRealPg("job claim under REAL contention (real Postgres, multiple connections)", () => {
  let r: RealDb;

  beforeAll(async () => {
    r = await makeRealDb();
    await warmPool(r.pool, PARALLEL);
  });
  afterAll(async () => {
    await r.close();
  });
  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE job_runs, orc_run_plans, orc_compile_diagnostics, orc_runs,
               quota_limits, memberships, projects, teams, users, organizations
      RESTART IDENTITY CASCADE`);
  });

  /**
   * One tenant plus `count` PENDING jobs on one run. Written with the owner connection on
   * purpose: this is a fixture, not a path under test, and RLS is exercised by the L2 layer.
   */
  const seedTeamWithJobs = async (count: number): Promise<string> => {
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const rows = await r.db.execute(query);
      const id: unknown = rows.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
      return id;
    };
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    const teamId = await one(
      sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId}, 'A', 'a') RETURNING id`,
    );
    const projectId = await one(
      sql`INSERT INTO projects (team_id, name, slug) VALUES (${teamId}, 'P', 'p') RETURNING id`,
    );
    const userId = await one(
      sql`INSERT INTO users (email, display_name) VALUES ('a@testkite.test', 'A') RETURNING id`,
    );
    const runId = await one(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${teamId}, ${projectId}, 'batch', ${userId}, 'ready') RETURNING id`);
    for (let i = 0; i < count; i += 1) {
      await r.db.execute(sql`
        INSERT INTO job_runs (team_id, run_id, chain_key) VALUES (${teamId}, ${runId}, ${`chain-${String(i)}`})`);
    }
    return teamId;
  };

  it("hands two workers disjoint sets of jobs", async () => {
    await seedTeamWithJobs(8);
    await dispatchPending(r.db, { limit: 8 });

    const [a, b] = await Promise.all([
      claimJobs(r.db, { workerId: "w-A", lane: "batch", max: 4 }),
      claimJobs(r.db, { workerId: "w-B", lane: "batch", max: 4 }),
    ]);

    const ids = new Set([...a, ...b].map((j) => j.jobRunId));
    expect(a.length + b.length).toBe(8);
    expect(ids.size, "a job claimed twice would run twice and bill twice").toBe(8);
    // Every claim bumped the epoch of a row nobody else had touched, so all of them read 1.
    expect([...a, ...b].every((j) => j.leaseEpoch === 1)).toBe(true);
  });

  it("never lets 8 workers over-claim a 3-job queue", async () => {
    await seedTeamWithJobs(3);
    await dispatchPending(r.db, { limit: 3 });

    const claims = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        claimJobs(r.db, { workerId: `w-${String(i)}`, lane: "batch", max: 2 }),
      ),
    );

    expect(claims.flat()).toHaveLength(3);
    expect(new Set(claims.flat().map((j) => j.jobRunId)).size).toBe(3);
  });

  it("dispatches each pending job exactly once even with two dispatchers racing", async () => {
    await seedTeamWithJobs(50);

    // Split brain is ALLOWED by design (the leader lease is an optimisation, not a
    // correctness condition — spike §3): two dispatchers ticking together must waste a tick,
    // never dispatch a job twice.
    const [n1, n2] = await Promise.all([
      dispatchPending(r.db, { limit: 50 }),
      dispatchPending(r.db, { limit: 50 }),
    ]);

    expect(n1 + n2).toBe(50);
  });
});
