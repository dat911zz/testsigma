CREATE TABLE "aut_cases" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_step_group" boolean DEFAULT false NOT NULL,
	"prereq_case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aut_cases_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "aut_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_prereq_fk" FOREIGN KEY ("team_id","prereq_case_id") REFERENCES "public"."aut_cases"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aut_cases_team_project_idx" ON "aut_cases" USING btree ("team_id","project_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_cases" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);