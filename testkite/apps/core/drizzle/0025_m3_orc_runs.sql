CREATE TYPE "public"."diagnostic_severity" AS ENUM('error', 'warning');--> statement-breakpoint
CREATE TYPE "public"."run_lane" AS ENUM('interactive', 'batch');--> statement-breakpoint
CREATE TYPE "public"."run_pin" AS ENUM('ready', 'latest');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('compiling', 'queued', 'running', 'finished');--> statement-breakpoint
CREATE TYPE "public"."run_verdict" AS ENUM('pending', 'passed', 'failed', 'compile_error', 'blocked', 'aborted_early', 'cancelled');--> statement-breakpoint
CREATE TABLE "orc_compile_diagnostics" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"severity" "diagnostic_severity" NOT NULL,
	"code" text NOT NULL,
	"case_id" text NOT NULL,
	"step_ordinal" integer,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_compile_diagnostics_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "orc_compile_diagnostics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orc_run_plans" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"plan_format_version" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_run_plans_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "orc_run_plans_team_run_unique" UNIQUE("team_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "orc_run_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orc_runs" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lane" "run_lane" DEFAULT 'batch' NOT NULL,
	"status" "run_status" DEFAULT 'compiling' NOT NULL,
	"verdict" "run_verdict" DEFAULT 'pending' NOT NULL,
	"plan_hash" text,
	"requested_by" uuid NOT NULL,
	"pin" "run_pin" NOT NULL,
	"chain_total" integer DEFAULT 0 NOT NULL,
	"chain_done" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_runs_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "orc_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orc_compile_diagnostics" ADD CONSTRAINT "orc_compile_diagnostics_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."orc_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orc_run_plans" ADD CONSTRAINT "orc_run_plans_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."orc_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orc_runs" ADD CONSTRAINT "orc_runs_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orc_runs" ADD CONSTRAINT "orc_runs_user_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orc_compile_diagnostics_team_run_idx" ON "orc_compile_diagnostics" USING btree ("team_id","run_id");--> statement-breakpoint
CREATE INDEX "orc_run_plans_team_hash_idx" ON "orc_run_plans" USING btree ("team_id","content_hash");--> statement-breakpoint
CREATE INDEX "orc_runs_team_created_idx" ON "orc_runs" USING btree ("team_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orc_runs_team_status_idx" ON "orc_runs" USING btree ("team_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orc_compile_diagnostics" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orc_run_plans" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orc_runs" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);