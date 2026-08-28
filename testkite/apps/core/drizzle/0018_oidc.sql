CREATE TYPE "public"."oidc_default_role" AS ENUM('team_admin', 'author', 'runner', 'viewer');--> statement-breakpoint
CREATE TABLE "idn_oidc_connectors" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text[] NOT NULL,
	"claim_email" text DEFAULT 'email' NOT NULL,
	"claim_groups" text DEFAULT 'groups' NOT NULL,
	"role_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_role" "oidc_default_role" DEFAULT 'viewer' NOT NULL,
	"allow_insecure_http" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idn_oidc_connectors_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "idn_oidc_connectors_team_name_unique" UNIQUE("team_id","name")
);
--> statement-breakpoint
ALTER TABLE "idn_oidc_connectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idn_oidc_login_states" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idn_oidc_login_states_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "idn_oidc_login_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idn_oidc_connectors" ADD CONSTRAINT "idn_oidc_connectors_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idn_oidc_login_states" ADD CONSTRAINT "idn_oidc_login_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idn_oidc_login_states" ADD CONSTRAINT "idn_oidc_login_states_connector_fk" FOREIGN KEY ("team_id","connector_id") REFERENCES "public"."idn_oidc_connectors"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idn_oidc_connectors_team_idx" ON "idn_oidc_connectors" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idn_oidc_login_states_state_uidx" ON "idn_oidc_login_states" USING btree ("state");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idn_oidc_connectors" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_lookup" ON "idn_oidc_connectors" AS PERMISSIVE FOR SELECT TO "testkite_auth" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idn_oidc_login_states" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "auth_lookup" ON "idn_oidc_login_states" AS PERMISSIVE FOR SELECT TO "testkite_auth" USING (true);