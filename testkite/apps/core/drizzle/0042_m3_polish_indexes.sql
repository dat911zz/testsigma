DROP INDEX "usage_counters_team_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "orc_run_tokens_live_uidx" ON "orc_run_tokens" USING btree ("team_id","job_run_id","attempt","lease_epoch") WHERE revoked_at IS NULL;--> statement-breakpoint
-- Handwritten, like the three partial indexes in 0028: drizzle-kit does not manage these
-- (they are not declared on the drizzle table), so the swap below is spelled out here.
--
-- REAPER INDEX, CORRECTED LEADING COLUMN. Both statements in queue/reaper.ts filter
-- `heartbeat_at < now() - <interval>` and NEITHER of them reads `lease_expires_at`: a lease
-- deadline records when the owner AGREED to stop, a heartbeat records when it last PROVED it
-- was alive, and only the second one detects a worker killed with -9. 0028 indexed the column
-- nobody filters on, so the sweep could not use it — and `lease_expires_at` is rewritten by
-- every heartbeat (every 5s per running chain), which made it the more expensive column to
-- index as well as the useless one.
DROP INDEX "job_runs_lease_idx";
--> statement-breakpoint
CREATE INDEX "job_runs_lease_idx" ON "job_runs" ("heartbeat_at") WHERE "status" = 'running';
