/**
 * Claim, lease and epoch — the whole ownership protocol of the queue of record.
 *
 * Every statement here is written so that CORRECTNESS IS `rowCount`, not a check the caller
 * must remember to perform:
 *   - claim  : `FOR UPDATE SKIP LOCKED` + `UPDATE ... SET lease_epoch = lease_epoch + 1`.
 *              Two workers claiming at the same instant get disjoint sets (measured
 *              2026-08-29: A=[1,2,3] B=[4,5,6], intersection = [], 8ms while A's tx was
 *              still open).
 *   - mutate : `UPDATE ... WHERE lease_epoch = $epoch`. A zombie writes 0 rows => 409
 *              STALE_EPOCH. There is no second mechanism and no "are you still the owner?"
 *              round trip.
 *
 * The claim path runs under `withDispatchRole` because the tenant is the ANSWER of the query,
 * not its input. Everything after the claim runs under `withTenant` with the team_id the
 * claim returned, so RLS is back in force for every subsequent statement.
 */
import { sql } from "drizzle-orm";
import {
  assertTenantContext,
  firstRow,
  rowsOf,
  withDispatchRole,
  withTenant,
  type SqlRow,
  type TenantContext,
  type TkDb,
  type TkTx,
} from "../../kernel/index.js";

/** How long a claim owns a chain before the reaper may take it back (blueprint §5). */
export const LEASE_SECONDS = 30;
/** Attempts an infrastructure error gets before the chain is failed for good. */
export const MAX_INFRA_ATTEMPTS = 3;
/** OOM count at which the chain stops being handed back to the fleet. */
export const OOM_QUARANTINE_THRESHOLD = 2;

export type JobLane = "interactive" | "batch";

export interface ClaimedJobRow {
  readonly jobRunId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: Date;
  readonly lane: JobLane;
}

export type EpochOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "stale_epoch"; readonly currentEpoch: number }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "cancelled" } // run aborted -> 410 JOB_CANCELLED
  | { readonly ok: false; readonly reason: "terminal" }; // already finished -> 410 JOB_TERMINAL

/** Statuses a job never leaves. `cancelled` is answered before this list is consulted. */
const TERMINAL: readonly string[] = ["succeeded", "failed", "cancelled", "rejected_quota"];

/**
 * node-postgres hands back a `Date` for timestamptz, PGlite a `Date` too, but a driver that
 * returned the raw string must not silently lose the milliseconds that `String(date)` drops.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toClaimedJob(row: SqlRow): ClaimedJobRow {
  return {
    jobRunId: String(row["id"]),
    teamId: String(row["team_id"]),
    runId: String(row["run_id"]),
    chainKey: String(row["chain_key"]),
    attempt: Number(row["attempt"]),
    leaseEpoch: Number(row["lease_epoch"]),
    leaseExpiresAt: toDate(row["lease_expires_at"]),
    lane: String(row["lane"]) === "interactive" ? "interactive" : "batch",
  };
}

/**
 * Dispatcher fan-out: pending -> dispatched. Deliberately NOT lane-scoped — the dispatcher
 * looks at the whole queue — which is why `job_runs_pending_idx` is (priority DESC, queue_seq)
 * with no leading lane column (measured: 0.205ms vs 10.007ms for the wrong index).
 *
 * A quarantined chain stays `pending` for every read path and is only invisible HERE: that is
 * the entire meaning of the quarantine column.
 */
export async function dispatchPending(db: TkDb, opts: { readonly limit: number }): Promise<number> {
  return withDispatchRole(db, async (tx) => {
    const result = await tx.execute(sql`
      WITH cand AS (
        SELECT team_id, id FROM job_runs
        WHERE status = 'pending' AND quarantined_at IS NULL
        ORDER BY priority DESC, queue_seq, id
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED)
      UPDATE job_runs j SET status = 'dispatched'
      FROM cand WHERE j.team_id = cand.team_id AND j.id = cand.id
      RETURNING j.id`);
    return rowsOf(result).length;
  });
}

/**
 * A worker takes ownership of at most `max` chains of its lane. The claim is lane-scoped, so
 * `job_runs_ready_idx` DOES lead with lane — the mirror image of the dispatcher's index, and
 * the reason the two are separate partial indexes rather than one shared one.
 */
export async function claimJobs(
  db: TkDb,
  input: {
    readonly workerId: string;
    readonly lane: JobLane;
    readonly max: number;
    readonly leaseSeconds?: number;
  },
): Promise<readonly ClaimedJobRow[]> {
  const lease = input.leaseSeconds ?? LEASE_SECONDS;
  return withDispatchRole(db, async (tx) => {
    const result = await tx.execute(sql`
      WITH cand AS (
        SELECT team_id, id FROM job_runs
        WHERE status = 'dispatched' AND lane = ${input.lane}
        ORDER BY priority DESC, queue_seq, id
        LIMIT ${input.max}
        FOR UPDATE SKIP LOCKED)
      UPDATE job_runs j
      SET status = 'running',
          lease_epoch = j.lease_epoch + 1,
          worker_id = ${input.workerId},
          lease_expires_at = now() + make_interval(secs => ${lease}::double precision),
          heartbeat_at = now(),
          started_at = COALESCE(j.started_at, now())
      FROM cand WHERE j.team_id = cand.team_id AND j.id = cand.id
      RETURNING j.id, j.team_id, j.run_id, j.chain_key, j.attempt, j.lease_epoch,
                j.lease_expires_at, j.lane`);
    return rowsOf(result).map(toClaimedJob);
  });
}

/**
 * Tells apart the four ways a mutation can miss, because the worker must react differently to
 * each: not_found = give up quietly (and never learn the job exists), cancelled = the run was
 * aborted, terminal = the job already ended, stale_epoch = you were reaped, drop everything
 * you were doing. Runs on the TENANT transaction, so another team's row is simply not there.
 */
async function classifyMiss(
  tx: TkTx,
  teamId: string,
  jobRunId: string,
): Promise<EpochOutcome<never>> {
  const row = firstRow(
    await tx.execute(sql`
      SELECT lease_epoch, status::text AS status FROM job_runs
       WHERE team_id = ${teamId} AND id = ${jobRunId}`),
  );
  if (row === undefined) return { ok: false, reason: "not_found" };
  const status = String(row["status"]);
  if (status === "cancelled") return { ok: false, reason: "cancelled" };
  if (TERMINAL.includes(status)) return { ok: false, reason: "terminal" };
  return { ok: false, reason: "stale_epoch", currentEpoch: Number(row["lease_epoch"]) };
}

export interface FencedJob {
  readonly runId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
}

/**
 * The fence for a mutation that is NOT itself a conditional UPDATE — an event, an artifact
 * slot, the results half of a complete. Those write to OTHER tables, so nothing about them
 * would notice that the chain has changed hands; this is what makes them notice.
 *
 * LOCK FIRST, TEST SECOND, and the two are separate statements on purpose. A single
 * `... WHERE lease_epoch = $epoch FOR UPDATE` evaluates its predicate against the snapshot the
 * statement STARTED with and only then takes the lock, so a reaper committing in between is
 * invisible to it — the exact shape that made the outbox relay publish twice (kernel/outbox,
 * commit c0c2f42). Locking by the immutable key `(team_id, id)` instead means Postgres waits
 * for that concurrent writer, re-reads the row it committed, and hands back the epoch that is
 * true NOW. The lock is then held for the rest of the transaction, so the result the caller
 * goes on to write cannot be overtaken by a reap either.
 *
 * Runs on the TENANT transaction: another team's row is simply not there, which is what makes
 * a cross-tenant job id a 404 rather than a 403.
 */
export async function fenceJob(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly jobRunId: string; readonly epoch: number },
): Promise<EpochOutcome<FencedJob>> {
  const teamId = assertTenantContext(ctx);
  const row = firstRow(
    await tx.execute(sql`
      SELECT run_id, chain_key, attempt, lease_epoch, status::text AS status FROM job_runs
       WHERE team_id = ${teamId} AND id = ${input.jobRunId}
       FOR UPDATE`),
  );
  if (row === undefined) return { ok: false, reason: "not_found" };
  const status = String(row["status"]);
  if (status === "cancelled") return { ok: false, reason: "cancelled" };
  if (TERMINAL.includes(status)) return { ok: false, reason: "terminal" };
  const leaseEpoch = Number(row["lease_epoch"]);
  // A requeued job (status back to `pending`) is stale for its previous owner too: the epoch
  // moved, so the comparison alone answers both cases without a second branch.
  if (leaseEpoch !== input.epoch || status !== "running") {
    return { ok: false, reason: "stale_epoch", currentEpoch: leaseEpoch };
  }
  return {
    ok: true,
    value: {
      runId: String(row["run_id"]),
      chainKey: String(row["chain_key"]),
      attempt: Number(row["attempt"]),
      leaseEpoch,
    },
  };
}

/**
 * "Is this id a job of THIS team?" — asked on the authentication path of `/internal/fleet`,
 * where a run token names one job and the request names another, to tell a worker bug (401,
 * the credential does not apply here) from a job the caller cannot see (404).
 *
 * Deliberately tenant-scoped, and deliberately answering only a boolean: it can therefore
 * never confirm that another team's id exists, which is the whole reason the answer for
 * "unknown" and "someone else's" has to be the same one.
 */
export async function jobExistsForTeam(
  db: TkDb,
  input: { readonly teamId: string; readonly jobRunId: string },
): Promise<boolean> {
  return withTenant(db, { teamId: input.teamId }, async (tx) => {
    const row = firstRow(
      await tx.execute(sql`
        SELECT 1 AS found FROM job_runs
         WHERE team_id = ${input.teamId} AND id = ${input.jobRunId}`),
    );
    return row !== undefined;
  });
}

/**
 * Extends the lease of a job the caller still owns. The deadline is computed from the
 * DATABASE clock, not from `input.now`: the reaper compares `lease_expires_at` against `now()`
 * too, and a skewed API host must not be able to buy itself extra lease time (or lose it).
 * `now` stays in the input because the caller's clock is what stamps the run aggregate.
 */
export async function heartbeatJob(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly epoch: number;
    readonly leaseSeconds?: number;
    readonly now: Date;
  },
): Promise<
  EpochOutcome<{ readonly leaseExpiresAt: Date; readonly command: "continue" | "drain" | "cancel" }>
> {
  const teamId = assertTenantContext(ctx);
  const lease = input.leaseSeconds ?? LEASE_SECONDS;
  const row = firstRow(
    await tx.execute(sql`
      UPDATE job_runs
         SET heartbeat_at = now(),
             lease_expires_at = now() + make_interval(secs => ${lease}::double precision)
       WHERE team_id = ${teamId} AND id = ${input.jobRunId}
         AND lease_epoch = ${input.epoch} AND status = 'running'
      RETURNING lease_expires_at`),
  );
  if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
  // `drain` and `cancel` arrive with the fleet-facing endpoints (Task 13): a worker that is
  // still the rightful owner of a running job is told to carry on.
  return { ok: true, value: { leaseExpiresAt: toDate(row["lease_expires_at"]), command: "continue" } };
}

export async function completeJob(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly epoch: number;
    readonly verdict: "passed" | "failed" | "aborted_early" | "cancelled";
    readonly infra: { readonly code: string; readonly message: string } | null;
    readonly now: Date;
  },
): Promise<
  EpochOutcome<{ readonly requeued: boolean; readonly attempt: number; readonly leaseEpoch: number }>
> {
  const teamId = assertTenantContext(ctx);
  const infra = input.infra;
  const finishedAt = input.now.toISOString();

  // AssertionFailure is a VERDICT. Retrying it would poison the result data with a second
  // opinion about a deterministic outcome — blueprint §4, taxonomy of errors. `aborted_early`
  // is a verdict too: the chain stopped because a step said so, not because a machine failed.
  if (infra === null) {
    const status =
      input.verdict === "passed" ? "succeeded" : input.verdict === "cancelled" ? "cancelled" : "failed";
    const row = firstRow(
      await tx.execute(sql`
        UPDATE job_runs
           SET status = ${status}, finished_at = ${finishedAt}::timestamptz,
               lease_expires_at = NULL, worker_id = NULL
         WHERE team_id = ${teamId} AND id = ${input.jobRunId}
           AND lease_epoch = ${input.epoch} AND status = 'running'
        RETURNING attempt, lease_epoch`),
    );
    if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
    return {
      ok: true,
      value: { requeued: false, attempt: Number(row["attempt"]), leaseEpoch: Number(row["lease_epoch"]) },
    };
  }

  const isOom = infra.code === "browser_oom";
  // ONE statement decides everything: requeue at the head of THIS team's queue, or fail for
  // good, or quarantine. Splitting it into read-then-write would open the exact window the
  // epoch is there to close. Every branch reads the OLD `attempt`/`oom_count`, so the
  // conditions all speak about the state the worker was reporting on.
  const row = firstRow(
    await tx.execute(sql`
      UPDATE job_runs SET
        oom_count = oom_count + ${isOom ? 1 : 0},
        last_error_code = ${infra.code},
        lease_epoch = lease_epoch + 1,
        worker_id = NULL,
        lease_expires_at = NULL,
        attempt = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN attempt + 1 ELSE attempt END,
        quarantined_at = CASE WHEN ${isOom} AND oom_count + 1 >= ${OOM_QUARANTINE_THRESHOLD}
                              THEN ${finishedAt}::timestamptz ELSE quarantined_at END,
        status = (CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN 'pending' ELSE 'failed' END)::job_status,
        finished_at = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN NULL ELSE ${finishedAt}::timestamptz END,
        queue_seq = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS}
          THEN (SELECT COALESCE(MIN(q.queue_seq), job_runs.queue_seq) - 1
                  FROM job_runs q WHERE q.team_id = job_runs.team_id AND q.status = 'pending')
          ELSE queue_seq END
       WHERE team_id = ${teamId} AND id = ${input.jobRunId}
         AND lease_epoch = ${input.epoch} AND status = 'running'
      RETURNING attempt, lease_epoch, status::text AS status`),
  );
  if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
  return {
    ok: true,
    value: {
      requeued: String(row["status"]) === "pending",
      attempt: Number(row["attempt"]),
      leaseEpoch: Number(row["lease_epoch"]),
    },
  };
}
