/**
 * Module planning — pln_environments (bản M2 tối thiểu cho onboarding).
 * blueprint §2: environment là PROJECT-SCOPED và base_url BẮT BUỘC.
 * Stub sinh lúc onboard mang status='stub' + base_url thật của team; chuyển 'active'
 * khi operator xác nhận (M4 bổ sung secret_refs, health probe).
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";
import { projects } from "../../identity/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const plnEnvStatus = pgEnum("pln_env_status", ["stub", "active", "archived"]);

export const plnEnvironments = pgTable(
  "pln_environments",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    status: plnEnvStatus("status").notNull().default("stub"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pln_environments_team_id_unique").on(t.teamId, t.id),
    unique("pln_environments_team_project_name_unique").on(t.teamId, t.projectId, t.name),
    index("pln_environments_team_idx").on(t.teamId, t.projectId),
    // Lớp L2: env không bao giờ trỏ sang project của team khác.
    foreignKey({
      name: "pln_environments_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    check("pln_environments_base_url_check", sql`${t.baseUrl} ~ '^https?://'`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
