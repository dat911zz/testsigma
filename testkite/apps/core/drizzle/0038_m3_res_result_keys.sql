-- res_case_result_keys — the IDEMPOTENCY KEY of a case result, held where a partitioned table
-- is not allowed to hold it.
--
-- WHY THIS TABLE EXISTS (measured 2026-08-30 on PostgreSQL 16, two independent pg.Pool
-- connections; reproduced by test/concurrency/result-attempt-race.test.ts):
-- `res_case_results` is PARTITIONED BY RANGE (started_at), and Postgres refuses a unique
-- constraint on a partitioned table unless the key contains every partitioning column. The
-- strongest key 0037 could therefore declare was
--   UNIQUE (team_id, job_run_id, case_id, attempt, started_at)
-- and `started_at` is a value the CALLER hands in (`writeCaseResults` passes `c.startedAt`
-- straight through). Two INDEPENDENT writes of the same (job, case, attempt) differ in it by
-- microseconds, so that constraint never fires: both INSERTs committed, two attempt-1 rows sat
-- on disk with two different verdicts, and `latestCaseResults()` answered with whichever row
-- carried the larger clock reading — a verdict picked by the system clock, silently.
--
-- This table has no partition key, so it can carry the real one:
--   PRIMARY KEY (team_id, job_run_id, case_id, attempt)
-- `writeCaseResults` claims that key FIRST, in the same transaction as the rows it fences, so
-- the DATABASE decides which writer owns an attempt. It is the same construction `orc_run_events`
-- uses for (job_run, attempt, seq) in `m3_run_events`, applied at the layer where the partition
-- key made it impossible to state inline.
--
-- The upstream lease/epoch fencing (T8-T10) should already stop a second worker from ever
-- reaching this key. That is exactly why the key is here: `writeCaseResults` is a public
-- module API, so its own invariant may not rest on a caller that happens to be careful today.
--
-- LIFETIME: this is a FENCE, not evidence, and it is the one result table with no partition to
-- DETACH. ON DELETE CASCADE hangs it off the job it fences, so it cannot become the table in
-- this module that grows forever.
CREATE TABLE "res_case_result_keys" (
  "team_id" uuid NOT NULL,
  "job_run_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "attempt" integer NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "res_case_result_keys_pkey" PRIMARY KEY ("team_id", "job_run_id", "case_id", "attempt"),
  CONSTRAINT "res_case_result_keys_job_fk" FOREIGN KEY ("team_id", "job_run_id")
    REFERENCES "public"."job_runs" ("team_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE "res_case_result_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- team_id leads the primary key, so a conflict can only ever be raised BY THE SAME TENANT;
-- the policy is what stops one tenant from reading which attempts another one has claimed.
CREATE POLICY "tenant_isolation" ON "res_case_result_keys" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
-- Append-only like the rows it fences: a claim may be taken, never released or rewritten. The
-- SELECT is what `INSERT ... ON CONFLICT DO NOTHING RETURNING` needs to report the claim back.
GRANT SELECT, INSERT ON "res_case_result_keys" TO "testkite_app";
