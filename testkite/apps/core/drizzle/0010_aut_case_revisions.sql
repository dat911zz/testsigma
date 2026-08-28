CREATE TABLE "aut_case_revisions" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"case_version" integer NOT NULL,
	"codec" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"payload_size" integer NOT NULL,
	"payload_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"note" text,
	CONSTRAINT "aut_case_revisions_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "aut_case_revisions_no_unique" UNIQUE("team_id","case_id","revision_no"),
	CONSTRAINT "aut_case_revisions_codec_known" CHECK (codec IN ('zstd','raw')),
	CONSTRAINT "aut_case_revisions_no_positive" CHECK (revision_no > 0 AND case_version > 0),
	CONSTRAINT "aut_case_revisions_sha256_hex" CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "aut_case_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "aut_case_revisions" ADD CONSTRAINT "aut_case_revisions_case_fk" FOREIGN KEY ("team_id","case_id") REFERENCES "public"."aut_cases"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aut_case_revisions_case_version_idx" ON "aut_case_revisions" USING btree ("team_id","case_id","case_version");--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_latest_revision_fk" FOREIGN KEY ("team_id","latest_revision_id") REFERENCES "public"."aut_case_revisions"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_ready_revision_fk" FOREIGN KEY ("team_id","ready_revision_id") REFERENCES "public"."aut_case_revisions"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_case_revisions" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);