CREATE TYPE "public"."aut_review_state" AS ENUM('open', 'approved', 'changes_requested', 'withdrawn');--> statement-breakpoint
CREATE TABLE "aut_case_reviews" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" "aut_review_state" DEFAULT 'open' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	CONSTRAINT "aut_case_reviews_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "aut_case_reviews_decided_shape" CHECK ((state = 'open' AND decided_by IS NULL AND decided_at IS NULL)
       OR (state <> 'open' AND decided_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "aut_case_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "aut_case_reviews" ADD CONSTRAINT "aut_case_reviews_case_fk" FOREIGN KEY ("team_id","case_id") REFERENCES "public"."aut_cases"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_case_reviews" ADD CONSTRAINT "aut_case_reviews_revision_fk" FOREIGN KEY ("team_id","revision_id") REFERENCES "public"."aut_case_revisions"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aut_case_reviews_case_idx" ON "aut_case_reviews" USING btree ("team_id","case_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "aut_case_reviews_one_open" ON "aut_case_reviews" USING btree ("team_id","case_id") WHERE state = 'open';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_case_reviews" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);