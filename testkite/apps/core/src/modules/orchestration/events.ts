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
 *
 * THE ORDER OF A RUN'S NARRATION is `run_ordinal` (migration `m3_run_events_ordinal`), not
 * `(attempt, seq)`. Those two are per-chain counters — every chain of a run restarts them at 1
 * — so they cannot order one chain against another, and a reader that tried would keep
 * renumbering its own output as chains join in. `run_ordinal` is allocated once per event from
 * a counter on the RUN, under that row's lock.
 *
 * LOCK ORDER, house rule: the run row is taken LAST. The events endpoint is already holding
 * this chain's `job_runs` row (`fenceJob`) when it gets here, and `abortRun` takes the same two
 * rows — jobs, then the run. Reaching for the run row first anywhere would close the cycle and
 * turn an abort landing during narration into a deadlock.
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
  /** The run-scoped ordinal — the SSE `id:` and the only stable order this run has. */
  readonly runOrdinal: number;
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
  // ALLOCATE FIRST, IN A STATEMENT OF ITS OWN — and the statement is an UPDATE because what is
  // wanted from it is the LOCK, not the arithmetic. Postgres holds a row lock until commit, so
  // the transaction that walks away with ordinal N could only have reached this line after the
  // holder of N-1 had committed and let go. Ordinal order is therefore COMMIT order, which is
  // the only order a `> cursor` reader can advance along without stepping over a write that is
  // still in flight. `nextval` would be cheaper and wrong: it hands out its number with no lock
  // at all, so a low number can surface after a high one has already been delivered and acked.
  const allocated = rowsOf(await tx.execute(sql`
    UPDATE orc_runs r SET event_ordinal = r.event_ordinal + 1
    FROM job_runs j
    WHERE j.team_id = ${teamId} AND j.id = ${input.jobRunId}
      AND r.team_id = j.team_id AND r.id = j.run_id
    RETURNING r.event_ordinal AS run_ordinal`));
  // Nothing to allocate against means there is no such job for this tenant. That is NOT decided
  // here: the composite FK below is this table's one authority on which (team, job) pairs
  // exist, and letting it answer keeps a cross-tenant write refused by the same constraint,
  // with the same message, as before there was an ordinal at all.
  const runOrdinal = Number(allocated[0]?.["run_ordinal"] ?? 0);

  // `rowsOf` rather than the plan block's `result.rows`: TkTx is deliberately driver-agnostic
  // (PgDatabase<PgQueryResultHKT>), so `execute()` is typed `unknown` and `.rows` does not
  // compile — the guard is the codebase's answer to that, and it beats an `as` cast.
  const inserted = rowsOf(await tx.execute(sql`
    INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, run_ordinal, kind, payload)
    VALUES (${teamId}, ${input.jobRunId}, ${input.attempt}, ${input.seq}, ${runOrdinal},
            ${input.kind}, ${JSON.stringify(input.payload)}::jsonb)
    ON CONFLICT ON CONSTRAINT orc_run_events_seq_unique DO NOTHING
    RETURNING id`));
  // A duplicate is a SUCCESS for the caller: at-least-once delivery means retries are normal
  // traffic, and answering 409 would make a healthy worker look broken. It burned an ordinal —
  // the allocator runs before the conflict is known — and that gap is deliberately harmless:
  // readers filter with `>`, never `cursor + 1`.
  return { accepted: true, duplicate: inserted.length === 0 };
}

/**
 * Every event of one run, in narration order. `afterOrdinal` is the SSE resume cursor: a
 * reconnecting client says which `run_ordinal` it last received, and gets what came after.
 *
 * ORDER BY `run_ordinal`, never `(attempt, seq)`. Both of those restart at 1 for every chain,
 * and the chains of one run advance independently — so ordering by them puts a late-starting
 * chain's first event IN FRONT of events already delivered from another chain, which both
 * renumbers what was sent and hides the new one below the client's cursor forever.
 *
 * `team_id` is pinned explicitly even though RLS already fences the read — it is what makes the
 * (team_id, job_run_id, attempt, seq) btree behind `orc_run_events_seq_unique` usable, and a
 * query that only works because a policy happens to be attached is one migration away from
 * being a cross-tenant read.
 */
export async function readRunEvents(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly runId: string; readonly afterOrdinal?: number },
): Promise<readonly StoredRunEvent[]> {
  const teamId = assertTenantContext(ctx);
  const after = input.afterOrdinal ?? 0;
  const rows = rowsOf(await tx.execute(sql`
    SELECT e.job_run_id, e.attempt, e.seq, e.run_ordinal, e.kind, e.payload, e.received_at
    FROM orc_run_events e
    JOIN job_runs j ON j.team_id = e.team_id AND j.id = e.job_run_id
    WHERE e.team_id = ${teamId} AND j.run_id = ${input.runId} AND e.run_ordinal > ${after}
    ORDER BY e.run_ordinal`));
  return rows.map((row) => ({
    runOrdinal: Number(row["run_ordinal"]),
    jobRunId: String(row["job_run_id"]),
    attempt: Number(row["attempt"]),
    seq: Number(row["seq"]),
    kind: String(row["kind"]) as RunEventKind,
    payload: (row["payload"] ?? {}) as Readonly<Record<string, unknown>>,
    receivedAt: toDate(row["received_at"]),
  }));
}
