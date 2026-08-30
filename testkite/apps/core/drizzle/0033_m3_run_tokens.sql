CREATE TABLE "orc_run_tokens" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"lease_epoch" integer NOT NULL,
	"worker_id" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_run_tokens_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "orc_run_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orc_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"lane" text NOT NULL,
	"capacity" integer NOT NULL,
	"drain" boolean DEFAULT false NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"free_slots" integer DEFAULT 0 NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orc_workers_lane_check" CHECK ("orc_workers"."lane" IN ('interactive','batch'))
);
--> statement-breakpoint
ALTER TABLE "orc_run_tokens" ADD CONSTRAINT "orc_run_tokens_job_fk" FOREIGN KEY ("team_id","job_run_id") REFERENCES "public"."job_runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orc_run_tokens_team_job_idx" ON "orc_run_tokens" USING btree ("team_id","job_run_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "orc_run_tokens_hash_uidx" ON "orc_run_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "orc_workers_hash_uidx" ON "orc_workers" USING btree ("token_hash");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "orc_run_tokens" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_lookup" ON "orc_run_tokens" AS PERMISSIVE FOR SELECT TO "testkite_auth" USING (true);