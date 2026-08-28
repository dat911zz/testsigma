/**
 * Kiểu drizzle cho audit_events. DDL KHÔNG sinh từ file này.
 *
 * File đặt tên `audit-schema.ts` (không phải `schema.ts`) CÓ CHỦ ĐÍCH: glob của
 * drizzle.config.ts là `./src/modules/<module>/db/schema.ts` (viết `<module>` thay
 * cho dấu sao vì `*` + `/` đóng sớm chính block comment này), nên bảng này nằm
 * ngoài tầm drizzle-kit — nếu không, drizzle-kit sẽ sinh một CREATE TABLE phẳng
 * đè lên thiết kế partition trong drizzle/0017_audit_events.sql.
 * Test `audit-partition.test.ts` so cột hai bên để chúng không trôi khỏi nhau.
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
