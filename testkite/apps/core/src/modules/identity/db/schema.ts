/**
 * Module identity — bộ ba tenancy (ownership.json: organizations/teams/projects/users/memberships).
 * Blueprint §3: organizations (1 row) → teams (= TENANT) → projects → tài sản.
 * Mọi bảng tenant-scoped: team_id dẫn đầu index + UNIQUE(team_id, id) làm mỏ neo composite FK.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  foreignKey,
  index,
  jsonb,
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
import { appRole, authRole } from "../../kernel/index.js";

/** bytea: drizzle 0.45 chưa có builder sẵn. Lưu Buffer thô, không base64/hex. */
const customBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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
    // Đường xác thực đọc membership của user KHI CHƯA biết tenant (chọn team nào).
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();

export const apiTokenKind = pgEnum("api_token_kind", ["user_pat", "service", "session"]);

/**
 * Token gắn ĐÚNG MỘT team (blueprint §3). Người ở nhiều team ⇒ nhiều token.
 * `token_hash` là SHA-256 raw 32 byte; secret không tồn tại ở đâu trong DB.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: customBytea("token_hash").notNull(),
    kind: apiTokenKind("kind").notNull(),
    userId: uuid("user_id").references(() => users.id),
    scopes: text("scopes").array().notNull(),
    // Hạn BẮT BUỘC — không có token vĩnh viễn trong hệ này.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("api_tokens_team_id_unique").on(t.teamId, t.id),
    uniqueIndex("api_tokens_token_hash_uidx").on(t.tokenHash),
    index("api_tokens_team_idx").on(t.teamId, t.createdAt),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
    // Đường xác thực: CHỈ SELECT, KHÔNG withCheck ⇒ role này không ghi được gì.
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();

export const oidcDefaultRole = pgEnum("oidc_default_role", [
  "team_admin",
  "author",
  "runner",
  "viewer",
]);

/**
 * Connector OIDC generic. IdP chốt cho prod là Keycloak self-host (28-08-2026),
 * nhưng KHÔNG có một dòng code nào riêng cho Keycloak: mọi thứ đi qua discovery
 * document chuẩn ⇒ đổi sang Authentik/Okta chỉ là đổi issuer_url.
 *
 * `client_secret` là secret THẬT nằm trong DB. M2 lưu thẳng; M4 (module sec_) sẽ
 * bọc envelope encryption — ghi vào ARCHITECTURE_AUDIT khi làm.
 */
export const idnOidcConnectors = pgTable(
  "idn_oidc_connectors",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret").notNull(),
    scopes: text("scopes").array().notNull(),
    claimEmail: text("claim_email").notNull().default("email"),
    claimGroups: text("claim_groups").notNull().default("groups"),
    /** group IdP -> vai TestKite. Không khớp gì ⇒ defaultRole. */
    roleMapping: jsonb("role_mapping").notNull().default({}),
    defaultRole: oidcDefaultRole("default_role").notNull().default("viewer"),
    /** CHỈ bật cho mock/dev. Prod Keycloak luôn https. */
    allowInsecureHttp: boolean("allow_insecure_http").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("idn_oidc_connectors_team_id_unique").on(t.teamId, t.id),
    unique("idn_oidc_connectors_team_name_unique").on(t.teamId, t.name),
    index("idn_oidc_connectors_team_idx").on(t.teamId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();

/**
 * Neo `(connector, subject)` → user. ĐÂY LÀ MỎ NEO DANH TÍNH, không phải email.
 *
 * VÌ SAO PHẢI CÓ BẢNG NÀY: `users` là bảng TOÀN CỤC (xem ghi chú ở trên) còn connector
 * OIDC thì MỖI TEAM tự cấu hình — team nào cũng trỏ được về Keycloak của chính mình và
 * khai claim `email` tuỳ ý. Khớp identity vào user cũ bằng email ⇒ team B mint được
 * phiên mang userId thật của người chỉ thuộc team A. `sub` của IdP là thứ duy nhất ổn
 * định và không giả được bởi team KHÁC (nó chỉ có nghĩa trong phạm vi connector này),
 * nên nó là khoá tra cứu; email chỉ còn dùng cho lần đầu, dưới hai điều kiện chặt
 * (xem `oidc/connector.ts`).
 *
 * KHÔNG có policy `auth_lookup`: mọi truy cập đều xảy ra SAU khi đã biết team (team của
 * connector), tức luôn đi qua `withTenant` + role app. Đường `testkite_auth` không cần
 * đọc bảng này, nên không được cấp quyền đọc nó.
 */
export const idnOidcIdentities = pgTable(
  "idn_oidc_identities",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id").notNull(),
    /** `sub` của IdP — định danh bất biến, không đổi khi user đổi email. */
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("idn_oidc_identities_team_id_unique").on(t.teamId, t.id),
    // Một subject của một connector chỉ trỏ tới ĐÚNG MỘT user.
    uniqueIndex("idn_oidc_identities_connector_subject_uidx").on(t.connectorId, t.subject),
    index("idn_oidc_identities_team_idx").on(t.teamId),
    // Composite FK: neo không bao giờ trỏ sang connector của team khác (lớp L2).
    foreignKey({
      name: "idn_oidc_identities_connector_fk",
      columns: [t.teamId, t.connectorId],
      foreignColumns: [idnOidcConnectors.teamId, idnOidcConnectors.id],
    }),
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
 * State của một lượt đăng nhập OIDC. Sống trong DB chứ không cookie/bộ nhớ tiến trình:
 * (a) nhiều instance API, (b) state phải DÙNG MỘT LẦN — `consumed_at` là thứ chặn replay.
 * `code_verifier` là bí mật ngắn hạn (10 phút), xoá bằng job dọn hoặc TTL.
 */
export const idnOidcLoginStates = pgTable(
  "idn_oidc_login_states",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id").notNull(),
    state: text("state").notNull(),
    nonce: text("nonce").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("idn_oidc_login_states_team_id_unique").on(t.teamId, t.id),
    uniqueIndex("idn_oidc_login_states_state_uidx").on(t.state),
    // Composite FK: state không bao giờ trỏ sang connector của team khác (lớp L2).
    foreignKey({
      name: "idn_oidc_login_states_connector_fk",
      columns: [t.teamId, t.connectorId],
      foreignColumns: [idnOidcConnectors.teamId, idnOidcConnectors.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();
