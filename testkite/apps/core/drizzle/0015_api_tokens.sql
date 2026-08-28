CREATE TYPE "public"."api_token_kind" AS ENUM('user_pat', 'service', 'session');--> statement-breakpoint
CREATE ROLE "testkite_auth";--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"kind" "api_token_kind" NOT NULL,
	"user_id" uuid,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_uidx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_team_idx" ON "api_tokens" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE POLICY "auth_lookup" ON "memberships" AS PERMISSIVE FOR SELECT TO "testkite_auth" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_tokens" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_lookup" ON "api_tokens" AS PERMISSIVE FOR SELECT TO "testkite_auth" USING (true);