CREATE TYPE "public"."job_kind" AS ENUM('chain', 'element_verify', 'capture_session', 'env_probe');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'dispatched', 'running', 'succeeded', 'failed', 'cancelled', 'rejected_quota', 'unknown_after_restore');--> statement-breakpoint
CREATE ROLE "testkite_dispatch";--> statement-breakpoint
CREATE TABLE "job_runs" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"chain_key" text NOT NULL,
	"lane" text DEFAULT 'batch' NOT NULL,
	"job_kind" "job_kind" DEFAULT 'chain' NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"queue_seq" bigint NOT NULL,
	"cost" integer DEFAULT 1 NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"oom_count" integer DEFAULT 0 NOT NULL,
	"quarantined_at" timestamp with time zone,
	"last_error_code" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_runs_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "job_runs_team_run_chain_unique" UNIQUE("team_id","run_id","chain_key"),
	CONSTRAINT "job_runs_lane_check" CHECK ("job_runs"."lane" IN ('interactive','batch')),
	CONSTRAINT "job_runs_attempt_check" CHECK ("job_runs"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."orc_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_team_run_idx" ON "job_runs" USING btree ("team_id","run_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "job_runs" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dispatch_all" ON "job_runs" AS PERMISSIVE FOR ALL TO "testkite_dispatch" USING (true) WITH CHECK (true);