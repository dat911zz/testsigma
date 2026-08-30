/**
 * "Suspect at 15s, dead at 30s" (blueprint §5). Suspect is a METRIC only — a worker that is
 * a little late is still holding a real browser context, and yanking its job would double-run
 * a chain. Dead is an ACTION: bump the epoch (which instantly fences the old owner — measured
 * 2026-08-29: its next write updates 0 rows) and put the chain back at the head of its own
 * team's queue so that team does not lose its place behind everyone else's backlog.
 *
 * Runs ONLY inside the leader's tick. That is not just load-shedding: two reapers racing on
 * the same team both compute MIN(queue_seq)-1 and produce a tie (measured: both -> 0). The
 * order key ends with `id` so even a tie is deterministic, but the single-leader rule is why
 * a tie should never occur in the first place.
 *
 * The threshold is read from `heartbeat_at`, not from `lease_expires_at`: a lease deadline
 * says when the OWNER agreed to stop, a heartbeat says when it last proved it was alive, and
 * only the second one detects a worker killed with -9. Both timestamps are compared against
 * the DATABASE clock, so a skewed API host can neither reap early nor sleep through a death.
 */
import { sql } from "drizzle-orm";
import { rowsOf, withDispatchRole, type TkDb } from "../../kernel/index.js";
import { MAX_INFRA_ATTEMPTS } from "./job-queue.js";

export const HEARTBEAT_SUSPECT_SECONDS = 15;
export const HEARTBEAT_DEAD_SECONDS = 30;

export interface ReapResult {
  /** Running jobs late by more than 15s, counted BEFORE the sweep — the dead are a subset. */
  readonly suspect: number;
  readonly requeued: number;
  readonly failed: number;
}

export async function reapDeadLeases(
  db: TkDb,
  opts?: { readonly deadSeconds?: number },
): Promise<ReapResult> {
  const dead = opts?.deadSeconds ?? HEARTBEAT_DEAD_SECONDS;
  // The dispatch role, like every other queue-wide path: the reaper is looking for owners
  // that stopped reporting and cannot know whose chain it found until it has found it.
  return withDispatchRole(db, async (tx) => {
    const suspectRows = rowsOf(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM job_runs
         WHERE status = 'running'
           AND heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_SUSPECT_SECONDS}::double precision)`),
    );
    const suspect = Number(suspectRows[0]?.["n"] ?? 0);

    // ONE statement decides everything, exactly like completeJob's infra branch: requeue at
    // the head of THIS team's queue, or fail for good. Every branch reads the OLD `attempt`,
    // so all the conditions speak about the state the dead worker left behind.
    const reaped = await tx.execute(sql`
      UPDATE job_runs SET
        lease_epoch = lease_epoch + 1,
        worker_id = NULL,
        lease_expires_at = NULL,
        last_error_code = 'lease_expired',
        attempt = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN attempt + 1 ELSE attempt END,
        status = (CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN 'pending' ELSE 'failed' END)::job_status,
        finished_at = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN NULL ELSE now() END,
        queue_seq = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS}
          THEN (SELECT COALESCE(MIN(q.queue_seq), job_runs.queue_seq) - 1
                  FROM job_runs q WHERE q.team_id = job_runs.team_id AND q.status = 'pending')
          ELSE queue_seq END
       WHERE status = 'running'
         AND heartbeat_at < now() - make_interval(secs => ${dead}::double precision)
      RETURNING status::text AS status`);

    let requeued = 0;
    let failed = 0;
    for (const row of rowsOf(reaped)) {
      if (String(row["status"]) === "pending") requeued += 1;
      else failed += 1;
    }
    return { suspect, requeued, failed };
  });
}
