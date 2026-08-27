/**
 * Module identity — bộ ba tenancy (ownership.json: organizations/teams/projects/users/memberships).
 * Blueprint §3: organizations (1 row) → teams (= TENANT) → projects → tài sản.
 * Mọi bảng tenant-scoped: team_id dẫn đầu index + UNIQUE(team_id, id) làm mỏ neo composite FK.
 */
import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const membershipRole = pgEnum("membership_role", [
  "instance_operator",
  "org_admin",
  "team_admin",
  "author",
  "runner",
  "viewer",
]);

export const teamStatus = pgEnum("team_status", ["active", "suspended", "archived"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: teamStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("teams_org_slug_unique").on(t.orgId, t.slug), index("teams_org_idx").on(t.orgId)],
);

export const projects = pgTable(
  "projects",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mỏ neo composite FK: mọi tài sản trỏ về (team_id, id) chứ không phải id trần.
    unique("projects_team_id_unique").on(t.teamId, t.id),
    unique("projects_team_slug_unique").on(t.teamId, t.slug),
    index("projects_team_idx").on(t.teamId),
  ],
);

/** users là toàn cục (một người có thể ở nhiều team) — KHÔNG tenant-scoped. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_team_id_unique").on(t.teamId, t.id),
    unique("memberships_team_user_unique").on(t.teamId, t.userId),
    index("memberships_team_idx").on(t.teamId),
  ],
);
