CREATE TYPE "public"."egress_mode" AS ENUM('observe', 'enforce');--> statement-breakpoint
CREATE TYPE "public"."pln_env_status" AS ENUM('stub', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "quota_limits" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"max_concurrent_contexts" integer DEFAULT 8 NOT NULL,
	"max_runs_per_day" integer DEFAULT 200 NOT NULL,
	"max_storage_gb" integer DEFAULT 50 NOT NULL,
	"max_ai_tokens_per_month" integer DEFAULT 1000000 NOT NULL,
	"max_members" integer DEFAULT 25 NOT NULL,
	"max_projects" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quota_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "egress_policies" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" "egress_mode" DEFAULT 'observe' NOT NULL,
	"allowlist" text[] NOT NULL,
	"observe_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_policies_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "egress_policies_team_unique" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "egress_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pln_environments" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"status" "pln_env_status" DEFAULT 'stub' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pln_environments_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "pln_environments_team_project_name_unique" UNIQUE("team_id","project_id","name"),
	CONSTRAINT "pln_environments_base_url_check" CHECK ("pln_environments"."base_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "pln_environments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pln_environments" ADD CONSTRAINT "pln_environments_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quota_limits_team_idx" ON "quota_limits" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "egress_policies_team_idx" ON "egress_policies" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "pln_environments_team_idx" ON "pln_environments" USING btree ("team_id","project_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "quota_limits" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "egress_policies" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pln_environments" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);