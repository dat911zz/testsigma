/**
 * THE READ RULE: a run's result is the row with the HIGHEST attempt (blueprint §5).
 * Older attempts stay as evidence — an infra retry that flips a verdict is exactly the thing
 * an SRE needs to see afterwards — but no product surface ever shows two verdicts for one case.
 *
 * DISTINCT ON is the Postgres-native way to write it and reads as the rule itself:
 * "one row per case, ordered by attempt descending, take the first".
 *
 * Writes are APPEND-ONLY, and not by convention: the request-path role holds SELECT and INSERT
 * on these two tables and nothing else (migration `m3_res_results`), so an attempt-2 row is the
 * only way to CORRECT an attempt-1 row.
 *
 * That leaves the other half — nothing above stops a SECOND attempt-1 row from being appended
 * next to the first, and MAX(attempt) has no answer when there are two. The partitioned table
 * cannot state the rule itself: a unique constraint there must contain the partition column
 * `started_at`, which is a value the CALLER hands in, so two independent writes a microsecond
 * apart never collide (measured 2026-08-30 — see `m3_res_result_keys` and
 * test/concurrency/result-attempt-race.test.ts). `res_case_result_keys` holds the real key
 * instead, and `writeCaseResults` claims it in the same transaction as the rows.
 */
import { sql } from "drizzle-orm";
import {
  assertTenantContext,
  isSqlRow,
  rowsOf,
  type SqlRow,
  type TenantContext,
  type TkTx,
} from "../kernel/index.js";
import { RESULT_VERDICTS, type ResultVerdict } from "./db/results-schema.js";

/** 400 days, the same window audit events keep (blueprint §2). Retention itself is M6's job. */
export const RESULT_RETENTION_DAYS = 400;

/**
 * A STEP never carries `blocked`: that verdict says "a prerequisite chain failed, so this case
 * never ran", which is a statement about the chain, not about a step inside it. The column
 * shares one enum with the case verdict because Postgres enums are per-type, not per-column;
 * this narrower list is what the write path accepts.
 */
export const STEP_VERDICTS = ["passed", "failed", "skipped"] as const;
export type StepVerdict = (typeof STEP_VERDICTS)[number];
export type CaseVerdict = ResultVerdict;

export interface StepResultInput {
  readonly ordinal: number;
  readonly verdict: StepVerdict;
  readonly renderedSentence: string;
  readonly durationMs: number;
  readonly failureContext: Readonly<Record<string, unknown>> | null;
  readonly screenshotArtifactId: string | null;
  readonly thumbhash: string | null;
}

export interface CaseResultInput {
  readonly caseId: string;
  readonly chainKey: string;
  readonly verdict: CaseVerdict;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly steps: readonly StepResultInput[];
}

export interface CaseResultRow {
  readonly id: string;
  readonly startedAt: Date;
  readonly jobRunId: string;
  readonly caseId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly verdict: CaseVerdict;
  readonly durationMs: number;
  readonly finishedAt: Date | null;
}

export interface StepResultRow {
  readonly id: string;
  readonly ordinal: number;
  readonly attempt: number;
  readonly verdict: StepVerdict;
  readonly renderedSentence: string;
  readonly durationMs: number;
  readonly failureContext: Readonly<Record<string, unknown>> | null;
  readonly screenshotArtifactId: string | null;
  readonly thumbhash: string | null;
  readonly startedAt: Date;
}

/**
 * node-postgres hands back a `Date` for timestamptz, PGlite a `Date` too, but a driver that
 * returned the raw string must not silently lose the milliseconds that `String(date)` drops
 * (same helper as orchestration/events.ts and queue/job-queue.ts).
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Narrowing instead of `as`: the value comes off a driver typed `unknown`, so a cast would
 * assert something Postgres never promised. A verdict the enum does not contain is a schema
 * drift, and saying so loudly beats handing a bad string to the API layer.
 */
function toCaseVerdict(value: unknown): CaseVerdict {
  const text = String(value);
  const known = RESULT_VERDICTS.find((v) => v === text);
  if (known === undefined) throw new Error(`res_case_results.verdict is unknown: ${text}`);
  return known;
}

function toStepVerdict(value: unknown): StepVerdict {
  const text = String(value);
  const known = STEP_VERDICTS.find((v) => v === text);
  if (known === undefined) throw new Error(`res_step_results.verdict is unknown: ${text}`);
  return known;
}

function toCaseResultRow(row: SqlRow): CaseResultRow {
  return {
    id: String(row["id"]),
    startedAt: toDate(row["started_at"]),
    jobRunId: String(row["job_run_id"]),
    caseId: String(row["case_id"]),
    chainKey: String(row["chain_key"]),
    attempt: Number(row["attempt"]),
    verdict: toCaseVerdict(row["verdict"]),
    durationMs: Number(row["duration_ms"]),
    finishedAt: toNullableDate(row["finished_at"]),
  };
}

function toStepResultRow(row: SqlRow): StepResultRow {
  const failureContext: unknown = row["failure_context"];
  return {
    id: String(row["id"]),
    ordinal: Number(row["step_ordinal"]),
    attempt: Number(row["attempt"]),
    verdict: toStepVerdict(row["verdict"]),
    renderedSentence: String(row["rendered_sentence"]),
    durationMs: Number(row["duration_ms"]),
    failureContext: isSqlRow(failureContext) ? failureContext : null,
    screenshotArtifactId: toNullableString(row["screenshot_artifact_id"]),
    thumbhash: toNullableString(row["thumbhash"]),
    startedAt: toDate(row["started_at"]),
  };
}

/**
 * What one call actually stored. `duplicates` names the cases whose `(job, case, attempt)` was
 * already claimed — the caller learns it wrote nothing for them instead of assuming it did.
 */
export interface WriteCaseResultsOutcome {
  readonly written: readonly string[];
  readonly duplicates: readonly string[];
}

/**
 * Appends one attempt's results. An attempt is claimed EXACTLY ONCE, and the database is what
 * enforces that: the first statement per case takes the primary key of `res_case_result_keys`,
 * so a second writer racing on the same `(team, job, case, attempt)` blocks on that key and
 * then loses it — it writes no case row and no step rows, and says so in `duplicates`.
 *
 * WHY THE CLAIM IS A ROW AND NOT A `WHERE NOT EXISTS`: a predicate is evaluated against a
 * snapshot taken when the statement STARTS, so a writer that commits in between is invisible to
 * it — the exact shape that published outbox events twice until 2026-08-30 (kernel/outbox
 * relay, commit c0c2f42). A primary key has no such window: the loser waits for the winner's
 * transaction to finish and is refused on its outcome, not on a snapshot.
 *
 * A duplicate is NOT an error. A `complete` call retried after a network timeout is the common
 * case, and re-reporting the same attempt must stay a no-op rather than fail the whole batch.
 * A duplicate that is NOT a retry means two workers believed they held the same attempt — a
 * lease/epoch failure upstream (T8-T10) — and this is where it stops being silent.
 */
export async function writeCaseResults(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly runId: string;
    readonly jobRunId: string;
    readonly attempt: number;
    readonly cases: readonly CaseResultInput[];
  },
): Promise<WriteCaseResultsOutcome> {
  const teamId = assertTenantContext(ctx);
  const written: string[] = [];
  const duplicates: string[] = [];
  for (const c of input.cases) {
    // The claim, and the whole reason this transaction may go on to write anything. It also
    // catches a case listed twice in ONE call: the second copy conflicts with the row this
    // very transaction inserted a moment ago.
    const claimed = rowsOf(await tx.execute(sql`
      INSERT INTO res_case_result_keys (team_id, job_run_id, case_id, attempt)
      VALUES (${teamId}, ${input.jobRunId}, ${c.caseId}, ${input.attempt})
      ON CONFLICT (team_id, job_run_id, case_id, attempt) DO NOTHING
      RETURNING case_id`));
    if (claimed.length === 0) {
      duplicates.push(c.caseId);
      continue;
    }
    const caseRow = rowsOf(await tx.execute(sql`
      INSERT INTO res_case_results (team_id, run_id, job_run_id, case_id, chain_key, attempt,
                                    verdict, duration_ms, started_at, finished_at)
      VALUES (${teamId}, ${input.runId}, ${input.jobRunId}, ${c.caseId}, ${c.chainKey}, ${input.attempt},
              ${c.verdict}, ${c.finishedAt.getTime() - c.startedAt.getTime()}, ${c.startedAt}, ${c.finishedAt})
      RETURNING id, started_at`))[0];
    if (caseRow === undefined) {
      // RLS refuses a cross-tenant write with an error rather than 0 rows, so an empty
      // RETURNING here means the statement itself changed shape — never "not allowed".
      throw new Error("res_case_results: INSERT ... RETURNING produced no row");
    }
    const caseResultId = String(caseRow["id"]);
    // The parent's started_at is HALF the composite FK the step rows point at, so it goes back
    // in as a Date rather than as whatever the driver happened to hand over. Measured
    // 2026-08-30: drizzle's `execute()` installs its own type parsers, so BOTH pg and PGlite
    // return timestamptz as the string `2026-08-15 10:00:00.123+00` today — but a driver that
    // returned a `Date` would make `String(value)` print no milliseconds at all, and every
    // step insert would then fail 23503 against a key the parent row does not have. `toDate`
    // costs nothing and takes the write path out of that argument entirely.
    // It is also the step's OWN partition key here, which keeps a case and its steps in the
    // same month — retention detaches them as one.
    const caseStartedAt = toDate(caseRow["started_at"]);
    for (const s of c.steps) {
      await tx.execute(sql`
        INSERT INTO res_step_results (team_id, case_result_id, case_result_started_at, step_ordinal,
          attempt, verdict, rendered_sentence, duration_ms, failure_context, screenshot_artifact_id,
          thumbhash, started_at)
        VALUES (${teamId}, ${caseResultId}, ${caseStartedAt}, ${s.ordinal}, ${input.attempt}, ${s.verdict},
          ${s.renderedSentence}, ${s.durationMs},
          ${s.failureContext === null ? null : JSON.stringify(s.failureContext)}::jsonb,
          ${s.screenshotArtifactId}, ${s.thumbhash}, ${caseStartedAt})`);
    }
    written.push(c.caseId);
  }
  return { written, duplicates };
}

/**
 * One row per (job, case) of a run: the newest attempt, and nothing else.
 *
 * `team_id` is pinned explicitly even though RLS already fences the read — it is what makes
 * the (team_id, run_id, attempt DESC) btree usable, and a query that only works because a
 * policy happens to be attached is one migration away from being a cross-tenant read.
 * The outer ORDER BY is not decoration either: DISTINCT ON forces its own ordering, which
 * would otherwise hand the API layer rows sorted by a uuid.
 */
export async function latestCaseResults(
  tx: TkTx,
  ctx: TenantContext,
  runId: string,
): Promise<readonly CaseResultRow[]> {
  const teamId = assertTenantContext(ctx);
  const rows = rowsOf(await tx.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (job_run_id, case_id) id, started_at, job_run_id, case_id, chain_key,
             attempt, verdict, duration_ms, finished_at
      FROM res_case_results
      WHERE team_id = ${teamId} AND run_id = ${runId}
      ORDER BY job_run_id, case_id, attempt DESC, started_at DESC
    ) latest
    ORDER BY chain_key, case_id`));
  return rows.map(toCaseResultRow);
}

/**
 * The steps of ONE case result, in narration order. The case result id already names a single
 * attempt (a retry writes a NEW parent row), so the DISTINCT ON here is the same rule applied
 * one level down rather than a second filter: it makes a duplicated ordinal impossible to read
 * back as two steps.
 */
export async function latestStepResults(
  tx: TkTx,
  ctx: TenantContext,
  caseResultId: string,
): Promise<readonly StepResultRow[]> {
  const teamId = assertTenantContext(ctx);
  const rows = rowsOf(await tx.execute(sql`
    SELECT DISTINCT ON (step_ordinal) id, step_ordinal, attempt, verdict, rendered_sentence,
           duration_ms, failure_context, screenshot_artifact_id, thumbhash, started_at
    FROM res_step_results
    WHERE team_id = ${teamId} AND case_result_id = ${caseResultId}
    ORDER BY step_ordinal, attempt DESC, started_at DESC`));
  return rows.map(toStepResultRow);
}

/**
 * SQL for the monthly job (M6): ensures a partition exists for the next N months. It is DDL,
 * so it runs as the migration/owner role — `ensure_result_partition` has EXECUTE revoked from
 * PUBLIC precisely so nothing on the request path can reach it.
 *
 * `months` is interpolated, not bound: a parameter is not allowed inside a DO block's body.
 * Hence the guard — the only safe interpolation is one that cannot be anything but an integer.
 */
export function ensureResultPartitionsSql(months: number): string {
  if (!Number.isInteger(months) || months < 0 || months > 120) {
    throw new Error(`ensureResultPartitionsSql: months must be an integer in 0..120, got ${months}`);
  }
  return `DO $$ DECLARE i int; tname text; BEGIN
    FOREACH tname IN ARRAY ARRAY['res_case_results','res_step_results'] LOOP
      FOR i IN 0..${String(months)} LOOP
        PERFORM ensure_result_partition(tname, (date_trunc('month', now()) + (i || ' months')::interval)::date);
      END LOOP;
    END LOOP;
  END $$;`;
}
