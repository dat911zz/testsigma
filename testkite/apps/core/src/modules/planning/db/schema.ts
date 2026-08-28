/**
 * Module planning — pln_environments (the minimal M2 build for onboarding).
 * blueprint §2: an environment is PROJECT-SCOPED and base_url is REQUIRED.
 * The stub created at onboarding carries status='stub' + the team's real base_url; it turns
 * 'active' once an operator confirms it (M4 adds secret_refs, health probe).
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
    // Layer L2: an env can never point at another team's project.
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
