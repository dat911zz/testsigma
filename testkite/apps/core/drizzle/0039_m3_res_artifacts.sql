CREATE TABLE "res_artifacts" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "res_artifacts_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "res_artifacts_attempt_check" CHECK ("res_artifacts"."attempt" >= 1),
	CONSTRAINT "res_artifacts_kind_check" CHECK ("res_artifacts"."kind" IN ('trace','screenshot','screenshot_bundle','video','log')),
	CONSTRAINT "res_artifacts_status_check" CHECK ("res_artifacts"."status" IN ('pending','uploaded')),
	CONSTRAINT "res_artifacts_size_check" CHECK ("res_artifacts"."size_bytes" >= 0 AND "res_artifacts"."size_bytes" <= 2147483647)
);
--> statement-breakpoint
ALTER TABLE "res_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "res_artifacts" ADD CONSTRAINT "res_artifacts_job_fk" FOREIGN KEY ("team_id","job_run_id") REFERENCES "public"."job_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "res_artifacts_team_job_idx" ON "res_artifacts" USING btree ("team_id","job_run_id","attempt");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "res_artifacts" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);