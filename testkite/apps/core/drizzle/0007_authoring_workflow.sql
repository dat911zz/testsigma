CREATE TYPE "public"."aut_case_status" AS ENUM('draft', 'in_review', 'ready');--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "status" "aut_case_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "latest_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "ready_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "last_edited_by" uuid;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD COLUMN "promoted_by" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "allow_self_promote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_version_positive" CHECK (version > 0);--> statement-breakpoint
ALTER TABLE "aut_cases" ADD CONSTRAINT "aut_cases_status_timeline" CHECK ((status = 'draft')
       OR (status = 'in_review' AND submitted_at IS NOT NULL)
       OR (status = 'ready' AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL
           AND promoted_at IS NOT NULL AND ready_revision_id IS NOT NULL));