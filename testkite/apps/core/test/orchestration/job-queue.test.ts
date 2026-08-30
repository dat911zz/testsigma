/**
 * Lease and epoch semantics of the queue of record — on PGlite, deliberately.
 *
 * What this layer proves: which epoch a claim hands out, what a stale epoch does to a write,
 * that an assertion failure is a VERDICT and never a retry, and that infrastructure errors
 * run out of attempts (and out of patience: quarantine after 2 OOM). What it CANNOT prove is
 * that two workers claiming at the same instant get DISJOINT sets — PGlite has a single wasm
 * connection, so "concurrent" transactions merely queue up and a SKIP LOCKED assertion made
 * here would be theatre. That one lives in test/concurrency/job-claim-race.test.ts, on a real
 * Postgres.
 *
 * Deliberate deviations from the plan's block:
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as run-service.test.ts).
 *  - the foreign job id comes from seedJobs()'s return value instead of a firstJobId() helper;
 *    the harness already answers that question, a second way to ask it would only drift.
 *  - four extra tests, one per EpochOutcome branch the plan's eight leave unexecuted: the
 *    happy heartbeat, `terminal`, `cancelled`, and requeue-at-the-head-of-THIS-team's-queue.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firstRow, rowsOf, type SqlRow } from "../../src/modules/kernel/index.js";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  claimJobs,
  completeJob,
  dispatchPending,
  heartbeatJob,
  type ClaimedJobRow,
} from "../../src/modules/orchestration/queue/job-queue.js";

const now = new Date("2026-08-30T09:00:00Z");

/** One claimed job, or a loud failure — an assertion made on `undefined` proves nothing. */
function onlyJob(jobs: readonly ClaimedJobRow[]): ClaimedJobRow {
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  if (job === undefined) throw new Error("expected exactly one claimed job, got none");
  return job;
}

describe("job queue — lease and epoch", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
  });

  /** The single job of a team, read through the REQUEST path (app role + app.team_id). */
  const readJob = async (teamId: string): Promise<SqlRow> => {
    const row = firstRow(
      await t.asTeam(
        teamId,
        (tx) => tx.execute(sql`
          SELECT status::text AS status, attempt, lease_epoch, oom_count, quarantined_at,
                 last_error_code, queue_seq, worker_id, lease_expires_at
            FROM job_runs ORDER BY queue_seq LIMIT 1`),
      ),
    );
    if (row === undefined) throw new Error(`no job_runs row visible to team ${teamId}`);
    return row;
  };

  /** Dispatch + claim in one breath: most tests only care about the job they end up holding. */
  const dispatchAndClaimOne = async (): Promise<ClaimedJobRow> => {
    await dispatchPending(t.db, { limit: 1 });
    return onlyJob(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 }));
  };

  it("bumps lease_epoch on claim, so the claimer holds a number nobody else has", async () => {
    await t.seedJobs(a, 1);
    expect(await dispatchPending(t.db, { limit: 10 })).toBe(1);

    const job = onlyJob(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 }));

    expect(job.leaseEpoch).toBe(1);
    expect(job.attempt).toBe(1);
    expect(job.teamId).toBe(a.teamId);
    expect(job.lane).toBe("batch");
    // The lease is the worker's clock, not a decoration: without a deadline in the future the
    // reaper would take the job back before the first heartbeat could land.
    expect(job.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("claims nothing that the dispatcher has not released yet", async () => {
    await t.seedJobs(a, 3); // still `pending`

    expect(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 5 })).toEqual([]);
  });

  it("claims nothing for a lane the job does not belong to", async () => {
    await t.seedJobs(a, 2); // seeded on the `batch` lane
    await dispatchPending(t.db, { limit: 10 });

    expect(await claimJobs(t.db, { workerId: "w1", lane: "interactive", max: 5 })).toEqual([]);
  });

  it("extends the lease for a heartbeat that carries the current epoch", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job.jobRunId, epoch: job.leaseEpoch, now }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("heartbeat with the current epoch must be accepted");
    expect(res.value.command).toBe("continue");
    expect(res.value.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(job.leaseExpiresAt.getTime());
  });

  it("rejects a heartbeat that carries an old epoch (the zombie case)", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.bumpEpoch(job.teamId, job.jobRunId); // reaper took the job away

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job.jobRunId, epoch: job.leaseEpoch, now }),
    );

    expect(res).toMatchObject({
      ok: false,
      reason: "stale_epoch",
      currentEpoch: job.leaseEpoch + 1,
    });
  });

  it("never retries an assertion failure — a verdict is not an error", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "failed",
        infra: null,
        now,
      }),
    );

    expect(res).toMatchObject({ ok: true, value: { requeued: false, attempt: 1 } });
    expect(await readJob(a.teamId)).toMatchObject({ status: "failed" });
  });

  it("answers terminal for a job that already reached a verdict", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "passed",
        infra: null,
        now,
      }),
    );

    // A late heartbeat from a worker that finished but had not noticed yet. `terminal` and
    // `stale_epoch` mean opposite things to the worker (drop the job quietly vs. abandon
    // everything mid-flight), so the two must never be collapsed into one answer.
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job.jobRunId, epoch: job.leaseEpoch, now }),
    );

    expect(res).toEqual({ ok: false, reason: "terminal" });
    expect(await readJob(a.teamId)).toMatchObject({ status: "succeeded" });
  });

  it("answers cancelled for a job whose run was aborted", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "cancelled",
        infra: null,
        now,
      }),
    );

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job.jobRunId, epoch: job.leaseEpoch, now }),
    );

    expect(res).toEqual({ ok: false, reason: "cancelled" });
  });

  it("requeues an infrastructure error and bumps both attempt and epoch", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "failed",
        infra: { code: "browser_oom", message: "chromium killed by cgroup" },
        now,
      }),
    );

    expect(res).toMatchObject({ ok: true, value: { requeued: true, attempt: 2, leaseEpoch: 2 } });
    const row = await readJob(a.teamId);
    expect(row).toMatchObject({ status: "pending" });
    expect(Number(row["oom_count"])).toBe(1);
    expect(row["quarantined_at"]).toBeNull();
    // The old lease must be released by the same statement: a requeued job still carrying a
    // lease_expires_at and a worker_id would be reaped again for a lease nobody holds.
    expect(row["lease_expires_at"]).toBeNull();
    expect(row["worker_id"]).toBeNull();
  });

  it("puts a requeued job at the head of ITS OWN team's queue, not the whole table's", async () => {
    const aJobs = await t.seedJobs(a, 3);
    await t.seedJobs(b, 1);
    const headOfA = aJobs[0];
    const job = await dispatchAndClaimOne(); // the lowest queue_seq overall, i.e. team A's first
    expect(job.jobRunId).toBe(headOfA);
    const beforeB = await readJob(b.teamId);

    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "failed",
        infra: { code: "network", message: "reset" },
        now,
      }),
    );

    const order = rowsOf(
      await t.asTeam(
        a.teamId,
        (tx) => tx.execute(sql`
          SELECT id FROM job_runs WHERE status = 'pending'
           ORDER BY priority DESC, queue_seq, id`),
      ),
    ).map((row) => String(row["id"]));
    expect(order[0], "the retried chain is what the fleet must pick up next").toBe(headOfA);
    // MIN(queue_seq) is computed WITHIN the team: a requeue must not renumber, reorder or
    // otherwise touch another tenant's place in the queue.
    expect(await readJob(b.teamId)).toEqual(beforeB);
  });

  it("quarantines a chain after 2 OOM instead of feeding it back to the fleet forever", async () => {
    await t.seedJobs(a, 1);

    for (let i = 0; i < 2; i += 1) {
      const job = await dispatchAndClaimOne();
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        completeJob(tx, ctx, {
          jobRunId: job.jobRunId,
          epoch: job.leaseEpoch,
          verdict: "failed",
          infra: { code: "browser_oom", message: "oom" },
          now,
        }),
      );
    }

    const row = await readJob(a.teamId);
    expect(Number(row["oom_count"])).toBe(2);
    expect(row["quarantined_at"]).not.toBeNull();
    // Quarantined work is invisible to the dispatcher but still readable by the tenant —
    // that is why quarantine is a column and not a status.
    expect(await dispatchPending(t.db, { limit: 10 })).toBe(0);
    expect(row).toMatchObject({ status: "pending" });
  });

  it("gives up after MAX_INFRA_ATTEMPTS instead of looping forever", async () => {
    await t.seedJobs(a, 1);

    for (let i = 0; i < 3; i += 1) {
      const job = await dispatchAndClaimOne();
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        completeJob(tx, ctx, {
          jobRunId: job.jobRunId,
          epoch: job.leaseEpoch,
          verdict: "failed",
          infra: { code: "network", message: "reset" },
          now,
        }),
      );
    }

    const row = await readJob(a.teamId);
    expect(row).toMatchObject({ status: "failed", last_error_code: "network" });
    expect(Number(row["attempt"])).toBe(3);
  });

  it("answers not_found for a job id that belongs to another team", async () => {
    const foreignJobs = await t.seedJobs(b, 1);
    const foreign = foreignJobs[0];
    if (foreign === undefined) throw new Error("seedJobs returned no id");

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: foreign, epoch: 1, now }),
    );

    // Cross-tenant is 404, never 403: team A must not learn that this id exists at all.
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
