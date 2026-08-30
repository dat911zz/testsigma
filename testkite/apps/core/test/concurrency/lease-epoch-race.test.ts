/**
 * A worker dies mid-chain — the REAPER half of the ownership protocol, on REAL Postgres.
 *
 * WHY IT CANNOT LIVE ON PGlite: every claim here is about what happens when two connections
 * touch the SAME rows at the SAME time. PGlite has one wasm connection, so its "concurrent"
 * transactions merely queue up: a reaper racing a claim would never actually race, and the
 * assertion would be a FALSE GREEN (see test/harness/realpg.ts). The unit half of the reaper
 * — thresholds, attempt/epoch arithmetic, requeue-at-team-head — is proved in
 * test/orchestration/reaper.test.ts; what is proved HERE is that contention cannot make a
 * chain run twice or burn two attempts for one death.
 *
 * Three regressions this file exists to catch:
 *  1. reading the job then updating it in a second statement ⇒ two reapers both see `running`
 *     ⇒ one death costs two attempts and two epoch bumps;
 *  2. dropping `AND lease_epoch = $epoch` from a worker mutation ⇒ the -9'd zombie's late
 *     verdict overwrites the rescuer's chain (the exact double-report the epoch exists for);
 *  3. a reaper that requeues by DELETE + INSERT, or that touches rows outside `running` ⇒ the
 *     chain is handed to a rescuer while the reaper still thinks it owns the decision.
 *
 * `warmPool` precedes every race: on a cold pool `Promise.all` is not parallel at all — the
 * second caller must open a physical connection (TCP + auth) and only reaches the table after
 * the first has COMMITted, the false green documented in promote-lock.test.ts.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is
 * collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { rowsOf, withTenant, type SqlRow } from "../../src/modules/kernel/index.js";
import {
  claimJobs,
  completeJob,
  dispatchPending,
  heartbeatJob,
} from "../../src/modules/orchestration/queue/job-queue.js";
import { reapDeadLeases } from "../../src/modules/orchestration/queue/reaper.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;

const now = new Date("2026-08-30T09:00:00Z");

/** Opens `n` physical connections BEFORE the race, so `Promise.all` is parallel from the first ms. */
async function warmPool(pool: RealDb["pool"], n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

describeRealPg("a worker dies mid-chain (real Postgres, multiple connections)", () => {
  let r: RealDb;
  let teamId = "";

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
  const seedTeamWithJobs = async (count: number): Promise<readonly string[]> => {
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const rows = await r.db.execute(query);
      const id: unknown = rows.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
      return id;
    };
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    teamId = await one(
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
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        await one(sql`
          INSERT INTO job_runs (team_id, run_id, chain_key)
          VALUES (${teamId}, ${runId}, ${`chain-${String(i)}`}) RETURNING id`),
      );
    }
    return ids;
  };

  /**
   * Moves a job's heartbeat into the past. A test that waited 30s for real would be the same
   * assertion, thirty seconds slower; the reaper compares against the DATABASE clock either
   * way. `lease_expires_at` is left alone on purpose — see the harness note in pglite.ts.
   */
  const ageHeartbeat = async (jobRunId: string, seconds: number): Promise<void> => {
    const res = await r.db.execute(sql`
      UPDATE job_runs SET heartbeat_at = now() - make_interval(secs => ${seconds}::double precision)
       WHERE id = ${jobRunId} RETURNING id`);
    if (rowsOf(res).length !== 1) throw new Error(`ageHeartbeat: no job_runs row ${jobRunId}`);
  };

  const jobRows = async (): Promise<readonly SqlRow[]> =>
    rowsOf(
      await r.db.execute(sql`
        SELECT id, status::text AS status, attempt, lease_epoch, worker_id, queue_seq
          FROM job_runs ORDER BY priority DESC, queue_seq, id`),
    );

  it("requeues the chain exactly once and rejects every later write from the zombie", async () => {
    const [jobId] = await seedTeamWithJobs(1);
    if (jobId === undefined) throw new Error("seed returned no job");
    await dispatchPending(r.db, { limit: 1 });
    const [victim] = await claimJobs(r.db, { workerId: "w-victim", lane: "batch", max: 1 });
    if (victim === undefined) throw new Error("the victim claimed nothing");
    expect(victim.leaseEpoch).toBe(1);

    // kill -9: the process is gone, so the heartbeat simply stops. Nothing tells the control
    // plane about it; the missing heartbeat IS the signal.
    await ageHeartbeat(victim.jobRunId, 31);
    expect(await reapDeadLeases(r.db)).toMatchObject({ suspect: 1, requeued: 1, failed: 0 });

    await dispatchPending(r.db, { limit: 1 });
    const [rescuer] = await claimJobs(r.db, { workerId: "w-rescuer", lane: "batch", max: 1 });
    if (rescuer === undefined) throw new Error("the rescuer claimed nothing");
    expect(rescuer.jobRunId).toBe(victim.jobRunId);
    expect(rescuer.attempt).toBe(2);
    expect(rescuer.leaseEpoch).toBe(3); // 1 claim + 1 reap + 1 claim

    // The zombie wakes up on a machine that is still running and tries to finish its work.
    const zombie = { jobRunId: victim.jobRunId, epoch: victim.leaseEpoch, now };
    const late = await withTenant(r.db, { teamId }, async (tx) => ({
      heartbeat: await heartbeatJob(tx, { teamId }, zombie),
      verdict: await completeJob(tx, { teamId }, { ...zombie, verdict: "passed", infra: null }),
      infra: await completeJob(tx, { teamId }, {
        ...zombie,
        verdict: "failed",
        infra: { code: "browser_oom", message: "chromium killed by cgroup" },
      }),
    }));

    expect(late.heartbeat).toMatchObject({ ok: false, reason: "stale_epoch", currentEpoch: 3 });
    expect(late.verdict).toMatchObject({ ok: false, reason: "stale_epoch", currentEpoch: 3 });
    expect(late.infra).toMatchObject({ ok: false, reason: "stale_epoch", currentEpoch: 3 });

    // Exactly ONE row, one requeue: a chain requeued twice would bill twice and report twice.
    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: jobId,
      status: "running",
      attempt: 2,
      lease_epoch: 3,
      worker_id: "w-rescuer",
    });
  });

  it("costs one attempt per death even when two reapers sweep at the same instant", async () => {
    const ids = await seedTeamWithJobs(4);
    await dispatchPending(r.db, { limit: 4 });
    const claimed = await claimJobs(r.db, { workerId: "w-victim", lane: "batch", max: 4 });
    expect(claimed).toHaveLength(4);
    for (const job of claimed) await ageHeartbeat(job.jobRunId, 31);

    // Split brain is ALLOWED by design (the leader lease is an optimisation, not a
    // correctness condition — spike §3). Two reapers ticking together must waste a tick,
    // never reap one death twice: the second UPDATE re-checks `status = 'running'` after the
    // row lock is released and finds `pending`.
    const [first, second] = await Promise.all([reapDeadLeases(r.db), reapDeadLeases(r.db)]);

    expect(first.requeued + second.requeued).toBe(4);
    expect(first.failed + second.failed).toBe(0);
    const rows = await jobRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => String(row["status"]))).toEqual(["pending", "pending", "pending", "pending"]);
    // One death, one attempt, one epoch bump — 3 would mean the sweep ran twice on one row.
    expect(rows.map((row) => Number(row["attempt"]))).toEqual([2, 2, 2, 2]);
    expect(rows.map((row) => Number(row["lease_epoch"]))).toEqual([2, 2, 2, 2]);
    expect(new Set(ids)).toEqual(new Set(rows.map((row) => String(row["id"]))));
    // Concurrent requeues can tie on queue_seq (measured 2026-08-29 §4: both -> MIN-1). The
    // order key ends with `id`, so a tie is still served in ONE fixed order, read after read.
    expect((await jobRows()).map((row) => String(row["id"]))).toEqual(
      rows.map((row) => String(row["id"])),
    );
  });

  it("keeps SKIP LOCKED honest while the reaper is running concurrently with a claim", async () => {
    await seedTeamWithJobs(8);
    await dispatchPending(r.db, { limit: 8 });
    const dying = await claimJobs(r.db, { workerId: "w-victim", lane: "batch", max: 4 });
    expect(dying).toHaveLength(4);
    for (const job of dying) await ageHeartbeat(job.jobRunId, 31);
    const dead = new Set(dying.map((job) => job.jobRunId));

    const [reaped, claimA, claimB] = await Promise.all([
      reapDeadLeases(r.db),
      claimJobs(r.db, { workerId: "w-A", lane: "batch", max: 8 }),
      claimJobs(r.db, { workerId: "w-B", lane: "batch", max: 8 }),
    ]);

    const claimedIds = [...claimA, ...claimB].map((job) => job.jobRunId);
    expect(reaped).toMatchObject({ requeued: 4, failed: 0 });
    // The four still-dispatched chains go to the rescuers, the four dead ones go back to the
    // queue, and no chain is in both sets — that is what "no chain runs twice" means here.
    expect(claimedIds).toHaveLength(4);
    expect(new Set(claimedIds).size).toBe(4);
    expect(claimedIds.filter((id) => dead.has(id))).toEqual([]);

    const rows = await jobRows();
    const byStatus = new Map(rows.map((row) => [String(row["id"]), String(row["status"])]));
    expect(rows).toHaveLength(8);
    for (const id of claimedIds) expect(byStatus.get(id)).toBe("running");
    for (const id of dead) expect(byStatus.get(id)).toBe("pending");
    // A requeued chain must be waiting for the dispatcher, not still owned by the dead worker.
    expect(
      rows.filter((row) => String(row["status"]) === "pending" && row["worker_id"] !== null),
    ).toEqual([]);
  });
});
