CREATE TABLE "orc_run_events" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_run_events_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "orc_run_events_seq_unique" UNIQUE("team_id","job_run_id","attempt","seq"),
	CONSTRAINT "orc_run_events_seq_check" CHECK ("orc_run_events"."seq" >= 1),
	CONSTRAINT "orc_run_events_kind_check" CHECK ("orc_run_events"."kind" IN ('chain_started','case_started','case_finished','step_started','step_finished','screenshot','infra_error'))
);
--> statement-breakpoint
ALTER TABLE "orc_run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orc_run_events" ADD CONSTRAINT "orc_run_events_job_fk" FOREIGN KEY ("team_id","job_run_id") REFERENCES "public"."job_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orc_run_events" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);