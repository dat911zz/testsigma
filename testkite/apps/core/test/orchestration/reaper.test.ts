/**
 * The reaper: "suspect at 15s, dead at 30s" (blueprint §5) — on PGlite, deliberately.
 *
 * What this layer proves is the DECISION, not the contention: which job the reaper touches,
 * what it does to `attempt`/`lease_epoch`/`queue_seq` when it does, and that the previous
 * owner is fenced out the instant it happens. Whether a reap racing a claim can hand the same
 * chain to two workers is a question about locks, and PGlite's single wasm connection cannot
 * answer it — that half lives in test/concurrency/lease-epoch-race.test.ts.
 *
 * Deliberate deviations from the plan's block:
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as job-queue.test.ts).
 *  - reads go through `firstRow`/`rowsOf` and `status::text`, like the sibling suite, instead
 *    of indexing `.rows[0]` on an `unknown` result.
 *  - three extra tests the plan's five leave out: the `deadSeconds` knob, the queue_seq
 *    COLLISION when one sweep requeues two jobs of the same team (spike §4), and a head
 *    computed from the team's own pending jobs rather than the whole table's — the plan's
 *    ordering test cannot tell those two apart, because there the global minimum and the
 *    team's minimum happen to be the same row.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firstRow, rowsOf, type SqlRow } from "../../src/modules/kernel/index.js";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import { reapDeadLeases } from "../../src/modules/orchestration/queue/reaper.js";
import {
  claimJobs,
  completeJob,
  dispatchPending,
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

describe("lease reaper", () => {
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

  /** Every job of a team as the REQUEST path sees it (app role + app.team_id), in queue order. */
  const jobsOf = async (teamId: string): Promise<readonly SqlRow[]> =>
    rowsOf(
      await t.asTeam(
        teamId,
        (tx) => tx.execute(sql`
          SELECT id, chain_key, status::text AS status, attempt, lease_epoch, queue_seq,
                 worker_id, lease_expires_at, last_error_code, finished_at
            FROM job_runs ORDER BY priority DESC, queue_seq, id`),
      ),
    );

  /** The single job of a team, or a loud failure. */
  const onlyRow = async (teamId: string): Promise<SqlRow> => {
    const rows = await jobsOf(teamId);
    const row = rows[0];
    if (row === undefined) throw new Error(`no job_runs row visible to team ${teamId}`);
    expect(rows).toHaveLength(1);
    return row;
  };

  /** Dispatch + claim in one breath: most tests only care about the job they end up holding. */
  const dispatchAndClaimOne = async (): Promise<ClaimedJobRow> => {
    await dispatchPending(t.db, { limit: 1 });
    return onlyJob(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 }));
  };

  it("leaves a job alone while it is merely suspect (>15s, <30s)", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.ageHeartbeat(job.jobRunId, 17);

    const res = await reapDeadLeases(t.db);

    // A worker that is a little late still holds a real browser context; taking its chain
    // away would run that chain twice. Suspect is a METRIC, dead is the only ACTION.
    expect(res).toEqual({ suspect: 1, requeued: 0, failed: 0 });
    expect(await onlyRow(a.teamId)).toMatchObject({ status: "running", lease_epoch: 1 });
  });

  it("honours a shorter deadSeconds, so the same job is dead at a tighter threshold", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.ageHeartbeat(job.jobRunId, 17);

    expect(await reapDeadLeases(t.db, { deadSeconds: 10 })).toMatchObject({ requeued: 1 });
    expect(await onlyRow(a.teamId)).toMatchObject({ status: "pending", lease_epoch: 2 });
  });

  it("requeues a dead job ONCE, bumping attempt and epoch together", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.ageHeartbeat(job.jobRunId, 31);

    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 1, failed: 0 });
    // Running it again must be a no-op: the job is `pending` now, not `running`.
    expect(await reapDeadLeases(t.db)).toEqual({ suspect: 0, requeued: 0, failed: 0 });

    const row = await onlyRow(a.teamId);
    expect(row).toMatchObject({
      status: "pending",
      attempt: 2,
      lease_epoch: 2,
      last_error_code: "lease_expired",
    });
    // A requeued job still carrying a lease would be reaped again for a lease nobody holds,
    // and a `finished_at` would make it look terminal to every read path.
    expect(row["worker_id"]).toBeNull();
    expect(row["lease_expires_at"]).toBeNull();
    expect(row["finished_at"]).toBeNull();
  });

  it("puts the requeued job at the HEAD of its own team's queue, not the head of everyone's", async () => {
    await t.seedJobs(a, 2, ["a1", "a2"]);
    await t.seedJobs(b, 1, ["b1"]);
    await dispatchPending(t.db, { limit: 1 }); // a1 goes out first (lowest queue_seq)
    const job = onlyJob(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 }));
    await t.ageHeartbeat(job.jobRunId, 31);

    await reapDeadLeases(t.db);

    const order = rowsOf(
      await t.db.execute(sql`
        SELECT chain_key FROM job_runs WHERE status = 'pending'
         ORDER BY priority DESC, queue_seq, id`),
    ).map((row) => String(row["chain_key"]));
    expect(order).toEqual(["a1", "a2", "b1"]);
  });

  it("computes that head from ITS OWN team's pending jobs, not from the whole table's", async () => {
    // The ordering test above cannot tell a team-scoped MIN(queue_seq) from a global one:
    // there, team A's first pending job IS the table's first pending job. Here team B holds
    // the two lowest positions and never leaves the queue, so a global MIN would send the
    // reaped chain past team B's backlog — a tenant stealing another tenant's place.
    await t.seedJobs(b, 2, ["b1", "b2"]);
    const aJobs = await t.seedJobs(a, 2, ["a1", "a2"]);
    await t.raw.query(`UPDATE job_runs SET priority = 5 WHERE team_id = $1`, [a.teamId]);
    await dispatchPending(t.db, { limit: 1 }); // priority beats queue_seq, so a1 goes out
    const job = onlyJob(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 }));
    expect(job.jobRunId).toBe(aJobs[0]);
    const beforeB = await jobsOf(b.teamId);
    await t.ageHeartbeat(job.jobRunId, 31);

    await reapDeadLeases(t.db);

    const [a1, a2] = await jobsOf(a.teamId);
    if (a1 === undefined || a2 === undefined) throw new Error("team A must still have 2 jobs");
    expect(a1["chain_key"], "the reaped chain is what team A must run next").toBe("a1");
    expect(a1).toMatchObject({ status: "pending", attempt: 2 });
    expect(Number(a1["queue_seq"])).toBe(Number(a2["queue_seq"]) - 1);
    // MIN(queue_seq) is computed WITHIN the team: another tenant's place in the queue is
    // neither read as the answer nor rewritten as a side effect.
    expect(Number(a1["queue_seq"])).toBeGreaterThan(Number(beforeB[1]?.["queue_seq"] ?? 0));
    expect(await jobsOf(b.teamId)).toEqual(beforeB);
  });

  it("keeps the order deterministic when one sweep requeues two jobs of the same team", async () => {
    // Measured 2026-08-29 (spike §4): two requeues that read the same snapshot both land on
    // MIN(queue_seq) - 1, a TIE. The reaper only runs inside the leader's tick, so two
    // sweeps never overlap — but ONE sweep reaping two chains of one team hits the same tie
    // from inside a single statement, and the `id` tiebreak in the order key is what keeps
    // the queue from serving them in a different order on every read.
    await t.seedJobs(a, 3, ["a1", "a2", "a3"]);
    await dispatchPending(t.db, { limit: 2 });
    const claimed = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 2 });
    expect(claimed).toHaveLength(2);
    for (const job of claimed) await t.ageHeartbeat(job.jobRunId, 31);

    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 2, failed: 0 });

    const rows = await jobsOf(a.teamId);
    const keys = rows.map((row) => String(row["chain_key"]));
    expect(keys[2], "the chain nobody touched keeps its place at the back").toBe("a3");
    expect(new Set(keys.slice(0, 2))).toEqual(new Set(["a1", "a2"]));
    // Same read, twice: a tie that the order key cannot break would shuffle between reads.
    expect((await jobsOf(a.teamId)).map((row) => String(row["chain_key"]))).toEqual(keys);
    expect(rowsOf(await t.db.execute(sql`SELECT id FROM job_runs WHERE status = 'running'`))).toEqual(
      [],
    );
  });

  it("makes a zombie's write fail after the reaper took the job", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    await t.ageHeartbeat(job.jobRunId, 31);
    await reapDeadLeases(t.db);

    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      completeJob(tx, ctx, {
        jobRunId: job.jobRunId,
        epoch: job.leaseEpoch,
        verdict: "passed",
        infra: null,
        now,
      }),
    );

    // The epoch bump IS the fence: the old owner's verdict updates 0 rows, which the internal
    // plane turns into 409 STALE_EPOCH. No distributed lock, no "are you still the owner?".
    expect(res).toMatchObject({ ok: false, reason: "stale_epoch", currentEpoch: 2 });
    expect(await onlyRow(a.teamId)).toMatchObject({ status: "pending", attempt: 2 });
  });

  it("fails a job for good once the attempts run out", async () => {
    await t.seedJobs(a, 1);
    await t.setAttempt(a.teamId, 3);
    const job = await dispatchAndClaimOne();
    await t.ageHeartbeat(job.jobRunId, 31);

    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 0, failed: 1 });

    const row = await onlyRow(a.teamId);
    expect(row).toMatchObject({ status: "failed", attempt: 3, last_error_code: "lease_expired" });
    // A failed job is terminal: it must carry an end time, and it must not be dispatched again.
    expect(row["finished_at"]).not.toBeNull();
    expect(await dispatchPending(t.db, { limit: 10 })).toBe(0);
  });

  it("ignores jobs that are not running, however old their heartbeat looks", async () => {
    const jobs = await t.seedJobs(a, 2, ["a1", "a2"]);
    const [dispatchedId, pendingId] = jobs;
    if (dispatchedId === undefined || pendingId === undefined) {
      throw new Error("seedJobs returned fewer ids than asked for");
    }
    await dispatchPending(t.db, { limit: 1 }); // a1 leaves the queue, a2 stays pending
    await t.ageHeartbeat(dispatchedId, 120);
    await t.ageHeartbeat(pendingId, 120);

    // A queued chain has no owner to fence and no attempt to burn; only `running` means
    // "somebody promised to report back and stopped".
    expect(await reapDeadLeases(t.db)).toEqual({ suspect: 0, requeued: 0, failed: 0 });
    const statuses = (await jobsOf(a.teamId)).map((row) => String(row["status"]));
    expect(statuses).toEqual(["dispatched", "pending"]);
  });

  it("reaps a dead job of one team without looking at another team's rows", async () => {
    await t.seedJobs(a, 1, ["a1"]);
    await t.seedJobs(b, 1, ["b1"]);
    await dispatchPending(t.db, { limit: 2 });
    const claimed = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 2 });
    expect(claimed).toHaveLength(2);
    const victim = claimed.find((job) => job.teamId === a.teamId);
    if (victim === undefined) throw new Error("team A's job was not claimed");
    await t.ageHeartbeat(victim.jobRunId, 31);
    const beforeB = await jobsOf(b.teamId);

    expect(await reapDeadLeases(t.db)).toMatchObject({ suspect: 1, requeued: 1 });

    expect(await onlyRow(a.teamId)).toMatchObject({ status: "pending", lease_epoch: 2 });
    expect(await jobsOf(b.teamId)).toEqual(beforeB);
  });

  it("counts a suspect that is not yet visible to any tenant read", async () => {
    // The reaper runs as the DISPATCH role, with no app.team_id at all: its whole job is to
    // find owners that stopped reporting, and it cannot know whose chain it is until it has
    // found one. The metric therefore spans every tenant in one number.
    await t.seedJobs(a, 1);
    await t.seedJobs(b, 1);
    await dispatchPending(t.db, { limit: 2 });
    for (const job of await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 2 })) {
      await t.ageHeartbeat(job.jobRunId, 20);
    }

    expect(await reapDeadLeases(t.db)).toEqual({ suspect: 2, requeued: 0, failed: 0 });
  });

  it("reports nothing to do on an empty queue", async () => {
    expect(await reapDeadLeases(t.db)).toEqual({ suspect: 0, requeued: 0, failed: 0 });
  });

  it("uses the DATABASE clock, so a fresh heartbeat is never reaped", async () => {
    await t.seedJobs(a, 1);
    const job = await dispatchAndClaimOne();
    const before = firstRow(
      await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT heartbeat_at FROM job_runs`)),
    );

    expect(await reapDeadLeases(t.db)).toEqual({ suspect: 0, requeued: 0, failed: 0 });

    expect(job.leaseEpoch).toBe(1);
    expect(before?.["heartbeat_at"]).not.toBeNull();
    expect(await onlyRow(a.teamId)).toMatchObject({ status: "running", lease_epoch: 1 });
  });
});
