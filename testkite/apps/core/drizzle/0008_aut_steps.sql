CREATE TYPE "public"."aut_step_kind" AS ENUM('action', 'step_group', 'if', 'for', 'while', 'rest');--> statement-breakpoint
CREATE TABLE "aut_rest_steps" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb,
	"body" text,
	"store_as" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aut_rest_steps_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "aut_rest_steps_step_unique" UNIQUE("team_id","step_id"),
	CONSTRAINT "aut_rest_steps_method_known" CHECK (method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))
);
--> statement-breakpoint
ALTER TABLE "aut_rest_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "aut_step_loops" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" uuid NOT NULL,
	"data_profile_id" uuid,
	"max_iterations" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aut_step_loops_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "aut_step_loops_step_unique" UNIQUE("team_id","step_id"),
	CONSTRAINT "aut_step_loops_max_iterations_positive" CHECK (max_iterations IS NULL OR max_iterations > 0)
);
--> statement-breakpoint
ALTER TABLE "aut_step_loops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "aut_steps" (
	"team_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"ordinal" integer NOT NULL,
	"kind" "aut_step_kind" NOT NULL,
	"rendered_sentence" text NOT NULL,
	"verb_op_key" text,
	"element_id" uuid,
	"args" jsonb,
	"step_group_case_id" uuid,
	"condition_expected" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aut_steps_team_id_unique" UNIQUE("team_id","id"),
	CONSTRAINT "aut_steps_position_unique" UNIQUE NULLS NOT DISTINCT("team_id","case_id","parent_step_id","ordinal"),
	CONSTRAINT "aut_steps_ordinal_positive" CHECK (ordinal > 0),
	CONSTRAINT "aut_steps_kind_shape" CHECK ((kind = 'action'     AND verb_op_key IS NOT NULL AND step_group_case_id IS NULL AND condition_expected IS NULL)
       OR (kind = 'step_group' AND step_group_case_id IS NOT NULL AND verb_op_key IS NULL AND element_id IS NULL AND args IS NULL AND condition_expected IS NULL)
       OR (kind = 'if'         AND condition_expected IS NOT NULL AND array_length(condition_expected, 1) >= 1 AND verb_op_key IS NULL AND step_group_case_id IS NULL AND element_id IS NULL)
       OR (kind IN ('for','while') AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL)
       OR (kind = 'rest'       AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL))
);
--> statement-breakpoint
ALTER TABLE "aut_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "aut_rest_steps" ADD CONSTRAINT "aut_rest_steps_step_fk" FOREIGN KEY ("team_id","step_id") REFERENCES "public"."aut_steps"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_step_loops" ADD CONSTRAINT "aut_step_loops_step_fk" FOREIGN KEY ("team_id","step_id") REFERENCES "public"."aut_steps"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_steps" ADD CONSTRAINT "aut_steps_case_fk" FOREIGN KEY ("team_id","case_id") REFERENCES "public"."aut_cases"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_steps" ADD CONSTRAINT "aut_steps_parent_fk" FOREIGN KEY ("team_id","parent_step_id") REFERENCES "public"."aut_steps"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aut_steps" ADD CONSTRAINT "aut_steps_step_group_fk" FOREIGN KEY ("team_id","step_group_case_id") REFERENCES "public"."aut_cases"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aut_rest_steps_team_idx" ON "aut_rest_steps" USING btree ("team_id","step_id");--> statement-breakpoint
CREATE INDEX "aut_step_loops_team_idx" ON "aut_step_loops" USING btree ("team_id","step_id");--> statement-breakpoint
CREATE INDEX "aut_steps_team_case_idx" ON "aut_steps" USING btree ("team_id","case_id","ordinal");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_rest_steps" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_step_loops" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "aut_steps" AS PERMISSIVE FOR ALL TO "testkite_app" USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);