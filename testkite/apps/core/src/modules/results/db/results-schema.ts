/**
 * Drizzle types for the partitioned result tables. DDL is NOT generated from this file —
 * it is named `results-schema.ts`, not `schema.ts`, so drizzle.config.ts's glob
 * (`./src/modules/<module>/db/schema.ts`) cannot reach it. Same trick, same reason, as
 * governance/db/audit-schema.ts in M2: drizzle-kit would emit a flat CREATE TABLE and
 * silently undo the partitioning.
 * `test/results/partition.test.ts` compares the columns on both sides so they cannot drift.
 */
import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The four verdicts a CASE can end with. `blocked` is the one a step never carries: it means
 * "a prerequisite chain failed, so this case never ran", which is a statement about the chain
 * rather than about any single step (see STEP_VERDICTS in results-service.ts).
 */
export const RESULT_VERDICTS = ["passed", "failed", "skipped", "blocked"] as const;
export type ResultVerdict = (typeof RESULT_VERDICTS)[number];

export const resultVerdict = pgEnum("result_verdict", RESULT_VERDICTS);

export const resCaseResults = pgTable("res_case_results", {
  teamId: uuid("team_id").notNull(),
  id: uuid("id").notNull().defaultRandom(),
  // The partition key. It is part of the primary key too — Postgres refuses a unique
  // constraint on a partitioned table that leaves the partitioning column out (0A000).
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  runId: uuid("run_id").notNull(),
  jobRunId: uuid("job_run_id").notNull(),
  caseId: uuid("case_id").notNull(),
  chainKey: text("chain_key").notNull(),
  attempt: integer("attempt").notNull().default(1),
  verdict: resultVerdict("verdict").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * The idempotency key of a case result — the one thing `res_case_results` cannot hold itself.
 * A unique constraint on a partitioned table must contain the partitioning column, and
 * `started_at` comes from the caller, so "one row per (job, case, attempt)" is a rule only an
 * UNPARTITIONED table can state. `writeCaseResults` claims a row here before it writes the
 * result rows (migration `m3_res_result_keys`).
 */
export const resCaseResultKeys = pgTable("res_case_result_keys", {
  teamId: uuid("team_id").notNull(),
  jobRunId: uuid("job_run_id").notNull(),
  caseId: uuid("case_id").notNull(),
  attempt: integer("attempt").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const resStepResults = pgTable("res_step_results", {
  teamId: uuid("team_id").notNull(),
  id: uuid("id").notNull().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  caseResultId: uuid("case_result_id").notNull(),
  // Carries the parent's partition key: the composite FK has to reference the parent's full
  // unique key, and that key is required to contain started_at.
  caseResultStartedAt: timestamp("case_result_started_at", { withTimezone: true }).notNull(),
  stepOrdinal: integer("step_ordinal").notNull(),
  attempt: integer("attempt").notNull().default(1),
  verdict: resultVerdict("verdict").notNull(),
  renderedSentence: text("rendered_sentence").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  failureContext: jsonb("failure_context"),
  screenshotArtifactId: uuid("screenshot_artifact_id"),
  // ~30 bytes: the gallery paints every placeholder instantly and lazy-loads the real image
  // on scroll (blueprint §5.2 deep-compression tier 1).
  thumbhash: text("thumbhash"),
});
