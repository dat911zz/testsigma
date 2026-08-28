CREATE TABLE "idn_oidc_identities" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idn_oidc_identities_team_id_unique" UNIQUE("team_id","id")
);
--> statement-breakpoint
ALTER TABLE "idn_oidc_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idn_oidc_identities" ADD CONSTRAINT "idn_oidc_identities_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idn_oidc_identities" ADD CONSTRAINT "idn_oidc_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idn_oidc_identities" ADD CONSTRAINT "idn_oidc_identities_connector_fk" FOREIGN KEY ("team_id","connector_id") REFERENCES "public"."idn_oidc_connectors"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idn_oidc_identities_connector_subject_uidx" ON "idn_oidc_identities" USING btree ("connector_id","subject");--> statement-breakpoint
CREATE INDEX "idn_oidc_identities_team_idx" ON "idn_oidc_identities" USING btree ("team_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "idn_oidc_identities" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);