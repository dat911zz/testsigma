CREATE ROLE "testkite_relay";--> statement-breakpoint
CREATE TABLE "krn_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "krn_outbox_consumed" (
	"outbox_id" bigint NOT NULL,
	"consumer" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "krn_outbox_consumed_pk" PRIMARY KEY("outbox_id","consumer")
);
--> statement-breakpoint
ALTER TABLE "krn_outbox_consumed" ADD CONSTRAINT "krn_outbox_consumed_outbox_id_krn_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."krn_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "krn_outbox_ready_idx" ON "krn_outbox" USING btree ("available_at","id");