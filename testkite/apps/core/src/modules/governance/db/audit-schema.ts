/**
 * The drizzle types for audit_events. DDL is NOT generated from this file.
 *
 * The file is named `audit-schema.ts` (not `schema.ts`) ON PURPOSE: drizzle.config.ts's
 * glob is `./src/modules/<module>/db/schema.ts` (spelling out `<module>` instead of a
 * star, since `*` + `/` would close this very comment block early), so this table stays
 * outside drizzle-kit's reach — otherwise drizzle-kit would generate a flat CREATE TABLE
 * that overwrites the partitioned design in drizzle/0017_audit_events.sql.
 * The `audit-partition.test.ts` test compares columns on both sides so they can't drift apart.
 */
import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const auditSeverity = pgEnum("audit_severity", ["LOW", "MEDIUM", "HIGH"]);
export const auditActorKind = pgEnum("audit_actor_kind", ["user", "token", "system"]);

export const auditEvents = pgTable("audit_events", {
  teamId: uuid("team_id").notNull(),
  id: uuid("id").notNull().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actorKind: auditActorKind("actor_kind").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  severity: auditSeverity("severity").notNull(),
  targetKind: text("target_kind"),
  targetId: uuid("target_id"),
  requestId: text("request_id"),
  meta: jsonb("meta").notNull().default({}),
});
