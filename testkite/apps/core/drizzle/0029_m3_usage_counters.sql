CREATE TABLE "usage_counters" (
	"team_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"window_start" date NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_team_id_metric_window_start_pk" PRIMARY KEY("team_id","metric","window_start"),
	CONSTRAINT "usage_counters_used_check" CHECK ("usage_counters"."used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "usage_counters_team_idx" ON "usage_counters" USING btree ("team_id","metric","window_start");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "usage_counters" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);