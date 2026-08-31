-- Step identity on res_step_results (NIT 73). HANDWRITTEN: drizzle-kit does not emit the
-- backfill, and this table is PARTITIONED BY RANGE (started_at).
--
-- Evidence re-measured on 2026-08-31 against a real cluster, not copied from belief:
--  * ADD COLUMN on the parent reaches every partition INCLUDING res_step_results_default.
--  * ALTER COLUMN ... SET NOT NULL on the parent recurses the same way.
--  * a UNIQUE CONSTRAINT is accepted on a partitioned table when it contains the partition key,
--    and it really raises 23505 — while a bare CREATE UNIQUE INDEX would be invisible to
--    test/results/partition.test.ts, which reads pg_constraint.
--  * GRANT stays on the PARENT ONLY; a new column needs no new GRANT, because the existing
--    grants are table-level, not column-level.
--
-- WHY exec_seq IS NOT NULL BUT loop_path IS NULLABLE: every row has an execution number (an old
-- row's is reconstructed below from the only order it ever had), but no row that predates this
-- release has a loop position, and inventing '{}' for it would claim the step ran outside a loop.
-- NULL = "not reported"; '{}' = "reported: outside every loop".

ALTER TABLE "res_step_results" ADD COLUMN "exec_seq" integer;
--> statement-breakpoint
ALTER TABLE "res_step_results" ADD COLUMN "loop_path" integer[];
--> statement-breakpoint
-- Backfill. On any cluster that has never completed a chain this updates 0 rows; it is written
-- anyway because a migration must be correct on the cluster it meets, not on the one it hopes
-- for. Ordering by (step_ordinal, started_at) is the only order those rows ever carried.
UPDATE "res_step_results" r SET "exec_seq" = s.rn
FROM (
  SELECT "team_id", "id", "started_at",
         row_number() OVER (PARTITION BY "team_id", "case_result_id"
                            ORDER BY "step_ordinal", "started_at")::int AS rn
  FROM "res_step_results"
) s
WHERE r."team_id" = s."team_id" AND r."id" = s."id" AND r."started_at" = s."started_at"
  AND r."exec_seq" IS NULL;
--> statement-breakpoint
ALTER TABLE "res_step_results" ALTER COLUMN "exec_seq" SET NOT NULL;
--> statement-breakpoint
-- The invariant moves from the READ path to the WRITE path. `SELECT DISTINCT ON (step_ordinal)`
-- used to make a duplicated ordinal unreadable as two steps; that hid the duplicate instead of
-- preventing it, and it is exactly how a 3-row `for` reported one step. Now the database refuses
-- the second row, and the read path returns everything it stored.
ALTER TABLE "res_step_results"
  ADD CONSTRAINT "res_step_results_exec_unique"
  UNIQUE ("team_id", "case_result_id", "exec_seq", "started_at");
--> statement-breakpoint
-- Redundant now: the constraint's index leads with the same two columns and additionally gives
-- the read path its ORDER BY for free (same reasoning as 0042 dropping usage_counters_team_idx).
DROP INDEX IF EXISTS "res_step_results_team_case_idx";
