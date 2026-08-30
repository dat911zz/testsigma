CREATE TABLE "orc_dispatcher_lease" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"holder" text NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_tick_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orc_dispatcher_lease_singleton" CHECK ("orc_dispatcher_lease"."id" = 1)
);
