/**
 * Module identity — bộ ba tenancy (ownership.json: organizations/teams/projects/users/memberships).
 * Blueprint §3: organizations (1 row) → teams (= TENANT) → projects → tài sản.
 * Mọi bảng tenant-scoped: team_id dẫn đầu index + UNIQUE(team_id, id) làm mỏ neo composite FK.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
// Xuôi DAG: identity → kernel qua FACADE. `appRole` là role DB do kernel sở hữu.
import { appRole } from "../../kernel/index.js";

/**
 * Vị từ tenant dùng chung. NULLIF là BẮT BUỘC: `RESET app.team_id` để GUC lại
 * thành chuỗi rỗng (không phải NULL) ⇒ ''::uuid ném 22P02 thay vì fail-closed.
 * Đã kiểm chứng trên PG 16.13 thật và PGlite 18.3.
 */
const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const membershipRole = pgEnum("membership_role", [
  "instance_operator",
  "org_admin",
  "team_admin",
  "author",
  "runner",
  "viewer",
]);

export const teamStatus = pgEnum("team_status", ["active", "suspended", "archived"]);

export const userStatus = pgEnum("user_status", ["active", "suspended", "deactivated"]);

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
    /**
     * Four-eyes (blueprint §3): mặc định người-sửa-cuối KHÔNG được tự promote.
     * Team một người / team pilot bật cờ này để tự promote — quyết định của
     * team_admin, ghi audit, không phải mặc định im lặng.
     */
    allowSelfPromote: boolean("allow_self_promote").notNull().default(false),
  },
  (t) => [
    unique("teams_org_slug_unique").on(t.orgId, t.slug),
    index("teams_org_idx").on(t.orgId),
    // teams: cột khoá tenant là `id` chứ không phải `team_id`.
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: sql`id = NULLIF(current_setting('app.team_id', true), '')::uuid`,
      withCheck: sql`id = NULLIF(current_setting('app.team_id', true), '')::uuid`,
    }),
  ],
).enableRLS();

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
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/**
 * users là TOÀN CỤC (một người ở nhiều team) — KHÔNG tenant-scoped, KHÔNG RLS.
 * `email` lưu dạng đã chuẩn hoá chữ thường: unique index trên lower(email) là thứ
 * chặn "QA@Acme.test" và "qa@acme.test" thành hai tài khoản khác nhau.
 * `passwordHash` NULL = tài khoản chỉ đăng nhập bằng OIDC (không đặt mật khẩu nội bộ).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    status: userStatus("status").notNull().default("active"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_lower_uidx").on(sql`lower(${t.email})`)],
);

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
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
