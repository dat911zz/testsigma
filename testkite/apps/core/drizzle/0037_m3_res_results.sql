-- res_case_results / res_step_results: partitioned BY MONTH, kept 400 days (blueprint §2, §5).
-- HANDWRITTEN SQL because drizzle-kit 0.31 cannot emit PARTITION BY. Both tables sit OUTSIDE
-- drizzle.config.ts's schema glob on purpose (see results/db/results-schema.ts) — exactly the
-- arrangement audit_events uses in M2.
--
-- Evidence from the 2026-08-29 spike, re-run against THIS schema rather than copied from M2:
--  * a unique key must contain the partition key => PRIMARY KEY (team_id, id, started_at).
--    Leaving it out fails with 0A000.
--  * a composite FK FROM a partitioned table INTO a partitioned table WORKS, provided it carries
--    the parent's partition key => res_step_results must keep case_result_started_at.
--  * GRANT ON THE PARENT ONLY. Reproduced: GRANT SELECT on a child partition let a team-A
--    session read all 3 rows of both teams (a child has relrowsecurity = false).
--  * with a DEFAULT partition present, DETACH ... CONCURRENTLY fails with 55000, so retention
--    uses a plain DETACH inside a maintenance window.
CREATE TYPE "public"."result_verdict" AS ENUM('passed', 'failed', 'skipped', 'blocked');
--> statement-breakpoint
CREATE TABLE "res_case_results" (
  "team_id" uuid NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "run_id" uuid NOT NULL,
  "job_run_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "chain_key" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "verdict" "result_verdict" NOT NULL,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "finished_at" timestamp with time zone,
  CONSTRAINT "res_case_results_pkey" PRIMARY KEY ("team_id", "id", "started_at"),
  CONSTRAINT "res_case_results_attempt_unique" UNIQUE ("team_id", "job_run_id", "case_id", "attempt", "started_at"),
  CONSTRAINT "res_case_results_job_fk" FOREIGN KEY ("team_id", "job_run_id")
    REFERENCES "public"."job_runs" ("team_id", "id")
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
CREATE INDEX "res_case_results_team_run_idx" ON "res_case_results" ("team_id", "run_id", "attempt" DESC);
--> statement-breakpoint
CREATE TABLE "res_step_results" (
  "team_id" uuid NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "case_result_id" uuid NOT NULL,
  -- Carries the parent's partition key: a FK into a partitioned table must reference its
  -- full unique key, and that key is required to include started_at.
  "case_result_started_at" timestamp with time zone NOT NULL,
  "step_ordinal" integer NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "verdict" "result_verdict" NOT NULL,
  "rendered_sentence" text NOT NULL,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "failure_context" jsonb,
  "screenshot_artifact_id" uuid,
  -- ~30 bytes: the gallery paints every placeholder instantly and lazy-loads the real
  -- image on scroll (blueprint §5.2 deep-compression tier 1).
  "thumbhash" text,
  CONSTRAINT "res_step_results_pkey" PRIMARY KEY ("team_id", "id", "started_at"),
  CONSTRAINT "res_step_results_case_fk" FOREIGN KEY ("team_id", "case_result_id", "case_result_started_at")
    REFERENCES "public"."res_case_results" ("team_id", "id", "started_at")
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
CREATE INDEX "res_step_results_team_case_idx" ON "res_step_results" ("team_id", "case_result_id", "step_ordinal");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_result_partition(p_table text, p_month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  start_ts timestamptz := date_trunc('month', p_month::timestamptz);
  end_ts   timestamptz := date_trunc('month', p_month::timestamptz) + interval '1 month';
  part     text := p_table || '_' || to_char(start_ts, 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, p_table, start_ts, end_ts);
    RETURN 'created ' || part;
  END IF;
  RETURN 'exists ' || part;
END $$;
--> statement-breakpoint
DO $$
DECLARE i int; tname text;
BEGIN
  FOREACH tname IN ARRAY ARRAY['res_case_results','res_step_results'] LOOP
    FOR i IN 0..13 LOOP
      PERFORM ensure_result_partition(tname, (date_trunc('month', now()) + (i || ' months')::interval)::date);
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
-- Safety net: a row outside the seeded range lands here instead of being refused (23514).
CREATE TABLE "res_case_results_default" PARTITION OF "res_case_results" DEFAULT;
--> statement-breakpoint
CREATE TABLE "res_step_results_default" PARTITION OF "res_step_results" DEFAULT;
--> statement-breakpoint
ALTER TABLE "res_case_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "res_step_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "res_case_results" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "res_step_results" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
-- APPEND-ONLY. A result is evidence: a later attempt adds a ROW, it never edits the old one.
-- GRANT ON THE PARENT ONLY — never on a partition (see the header).
GRANT SELECT, INSERT ON "res_case_results" TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "res_step_results" TO "testkite_app";
--> statement-breakpoint
-- CREATE FUNCTION hands EXECUTE to PUBLIC by default, which would put a DDL helper on the
-- request path. Its only callers are the migration itself and the monthly job (M6), both
-- running as the owner — which keeps EXECUTE regardless of this REVOKE.
REVOKE EXECUTE ON FUNCTION ensure_result_partition(text, date) FROM PUBLIC;
