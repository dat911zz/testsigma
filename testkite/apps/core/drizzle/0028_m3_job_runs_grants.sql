-- drizzle-kit emits CREATE ROLE but not the role's ATTRIBUTES, not a partial index with DESC,
-- and not GRANT. Those three are handwritten here (same pattern as 0002/0004/0016 in M1/M2).
ALTER ROLE "testkite_dispatch" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_dispatch";
--> statement-breakpoint
-- Ordering counter for the queue. A plain sequence (not per-team) is enough: requeue moves a
-- job to MIN(queue_seq)-1 WITHIN its team, so the global counter only supplies monotonicity.
CREATE SEQUENCE IF NOT EXISTS job_runs_queue_seq;
--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "queue_seq" SET DEFAULT nextval('job_runs_queue_seq');
--> statement-breakpoint
GRANT USAGE ON SEQUENCE job_runs_queue_seq TO "testkite_app";
--> statement-breakpoint
-- Dispatcher scan: NO lane filter, so the index must NOT start with lane.
-- Measured 2026-08-29 on 20k pending rows: wrong index = 10.007ms seq scan, this one = 0.205ms.
CREATE INDEX "job_runs_pending_idx" ON "job_runs" ("priority" DESC, "queue_seq") WHERE "status" = 'pending';
--> statement-breakpoint
-- Worker claim: always lane-scoped, so lane leads here.
CREATE INDEX "job_runs_ready_idx" ON "job_runs" ("lane", "priority" DESC, "queue_seq") WHERE "status" = 'dispatched';
--> statement-breakpoint
-- Reaper. NOTE: this indexed `lease_expires_at`, which the reaper never filters on — both of
-- its statements read `heartbeat_at`. Corrected in 0042, which drops this index and recreates
-- it on `heartbeat_at`; the 0.010ms measured here was of a lookup the sweep does not perform.
CREATE INDEX "job_runs_lease_idx" ON "job_runs" ("lease_expires_at") WHERE "status" = 'running';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job_runs" TO "testkite_app";
--> statement-breakpoint
-- The dispatch path moves jobs; it never creates or deletes one. No INSERT, no DELETE.
GRANT SELECT, UPDATE ON "job_runs" TO "testkite_dispatch";
