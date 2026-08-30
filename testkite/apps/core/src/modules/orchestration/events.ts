/**
 * `orc_run_events` — recording and replaying a worker's narration of a chain.
 *
 * A worker delivers AT LEAST ONCE: it retries after a network blip, after a 502 from a
 * restarting API pod, after its own event loop stalled past the socket timeout. So the whole
 * design here is one idea — idempotency is a UNIQUE CONSTRAINT, not application logic:
 * `(team_id, job_run_id, attempt, seq)` plus `ON CONFLICT DO NOTHING`. A replay inserts 0 rows
 * and is answered `{ accepted: true, duplicate: true }`, because answering 409 would make a
 * healthy worker look broken and tempt it into "fixing" itself by renumbering.
 *
 * First write wins, on purpose: a replay carrying a DIFFERENT payload also inserts 0 rows, so
 * a confused (or compromised) worker cannot go back and rewrite what already happened. The
 * privilege layer says the same thing from the other side — the request-path role holds only
 * SELECT and INSERT here (migration `m3_run_events_grants`), never UPDATE or DELETE.
 */
import { sql } from "drizzle-orm";
import { assertTenantContext, rowsOf, type TenantContext, type TkTx } from "../kernel/index.js";
import { RUN_EVENT_KINDS, type RunEventKind } from "./db/fleet-schema.js";

// Re-exported from the schema module, where the CHECK constraint on `orc_run_events.kind` is
// built from this same array — the type and the column can therefore never disagree.
export { RUN_EVENT_KINDS, type RunEventKind };

/**
 * node-postgres hands back a `Date` for timestamptz, PGlite a `Date` too, but a driver that
 * returned the raw string must not silently lose the milliseconds that `String(date)` drops
 * (same helper as job-queue.ts and dispatcher/lease.ts).
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export interface RecordEventInput {
  readonly jobRunId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StoredRunEvent {
  readonly jobRunId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
}

export async function recordRunEvent(
  tx: TkTx,
  ctx: TenantContext,
  input: RecordEventInput,
): Promise<{ readonly accepted: boolean; readonly duplicate: boolean }> {
  const teamId = assertTenantContext(ctx);
  // `rowsOf` rather than the plan block's `result.rows`: TkTx is deliberately driver-agnostic
  // (PgDatabase<PgQueryResultHKT>), so `execute()` is typed `unknown` and `.rows` does not
  // compile — the guard is the codebase's answer to that, and it beats an `as` cast.
  const inserted = rowsOf(await tx.execute(sql`
    INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, kind, payload)
    VALUES (${teamId}, ${input.jobRunId}, ${input.attempt}, ${input.seq}, ${input.kind},
            ${JSON.stringify(input.payload)}::jsonb)
    ON CONFLICT ON CONSTRAINT orc_run_events_seq_unique DO NOTHING
    RETURNING id`));
  // A duplicate is a SUCCESS for the caller: at-least-once delivery means retries are normal
  // traffic, and answering 409 would make a healthy worker look broken.
  return { accepted: true, duplicate: inserted.length === 0 };
}

/**
 * Every event of one run, in narration order. `afterSeqByJob` is the SSE resume cursor: a
 * reconnecting client says how far it got PER JOB (the chains of one run advance
 * independently, so a single global seq would either replay or lose events).
 *
 * `team_id` is pinned explicitly even though RLS already fences the read — it is what makes the
 * (team_id, job_run_id, attempt, seq) btree behind `orc_run_events_seq_unique` usable, and a
 * query that only works because a policy happens to be attached is one migration away from
 * being a cross-tenant read.
 */
export async function readRunEvents(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly runId: string; readonly afterSeqByJob?: ReadonlyMap<string, number> },
): Promise<readonly StoredRunEvent[]> {
  const teamId = assertTenantContext(ctx);
  const rows = rowsOf(await tx.execute(sql`
    SELECT e.job_run_id, e.attempt, e.seq, e.kind, e.payload, e.received_at
    FROM orc_run_events e
    JOIN job_runs j ON j.team_id = e.team_id AND j.id = e.job_run_id
    WHERE e.team_id = ${teamId} AND j.run_id = ${input.runId}
    ORDER BY e.attempt, e.seq, e.job_run_id`));
  const after = input.afterSeqByJob;
  return rows
    .map((row) => ({
      jobRunId: String(row["job_run_id"]),
      attempt: Number(row["attempt"]),
      seq: Number(row["seq"]),
      kind: String(row["kind"]) as RunEventKind,
      payload: (row["payload"] ?? {}) as Readonly<Record<string, unknown>>,
      receivedAt: toDate(row["received_at"]),
    }))
    .filter((e) => after === undefined || e.seq > (after.get(e.jobRunId) ?? 0));
}
