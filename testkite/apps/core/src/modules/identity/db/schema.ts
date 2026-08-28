/**
 * identity module — the tenancy triple (ownership.json: organizations/teams/projects/users/memberships).
 * Blueprint §3: organizations (1 row) → teams (= TENANT) → projects → assets.
 * Every tenant-scoped table: team_id leads the index + UNIQUE(team_id, id) anchors the composite FK.
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
// Forward along the DAG: identity → kernel via the FACADE. `appRole` is a DB role owned by kernel.
import { appRole, authRole } from "../../kernel/index.js";

/** bytea: drizzle 0.45 has no builtin builder for it yet. Stores a raw Buffer, not base64/hex. */
const customBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * The shared tenant predicate. NULLIF is MANDATORY: `RESET app.team_id` sets the GUC back
 * to an empty string (not NULL) ⇒ ''::uuid throws 22P02 instead of failing closed.
 * Verified against real PG 16.13 and PGlite 18.3.
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
     * Four-eyes (blueprint §3): by default the last person to edit CANNOT self-promote.
     * A single-person or pilot team can flip this flag to self-promote — that's a
     * team_admin decision, written to audit, never a silent default.
     */
    allowSelfPromote: boolean("allow_self_promote").notNull().default(false),
  },
  (t) => [
    unique("teams_org_slug_unique").on(t.orgId, t.slug),
    index("teams_org_idx").on(t.orgId),
    // teams: the tenant key column is `id`, not `team_id`.
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
    // Composite FK anchor: every asset points at (team_id, id), never a bare id.
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
 * users is GLOBAL (one person, many teams) — NOT tenant-scoped, NO RLS.
 * `email` is stored lowercase-normalized: the unique index on lower(email) is what stops
 * "QA@Acme.test" and "qa@acme.test" from becoming two different accounts.
 * `passwordHash` NULL = an account that only logs in via OIDC (no internal password set).
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
    // The auth path reads a user's membership BEFORE the tenant is known (which team to pick).
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();

export const apiTokenKind = pgEnum("api_token_kind", ["user_pat", "service", "session"]);

/**
 * A token is tied to EXACTLY one team (blueprint §3). Someone on multiple teams ⇒ multiple tokens.
 * `token_hash` is a raw 32-byte SHA-256; the secret exists nowhere in the DB.
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
    // Expiry is MANDATORY — there is no permanent token in this system.
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
    // The auth path: SELECT only, NO withCheck ⇒ this role cannot write anything.
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
 * Generic OIDC connector. The IdP settled on for prod is self-hosted Keycloak
 * (2026-08-28), but there is NOT a single line of Keycloak-specific code: everything goes
 * through the standard discovery document ⇒ switching to Authentik/Okta is just changing issuer_url.
 *
 * `client_secret` is a REAL secret living in the DB. M2 stores it in plaintext; M4 (the
 * sec_ module) will wrap it in envelope encryption — record that in ARCHITECTURE_AUDIT when done.
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
    /** IdP group -> TestKite role. No match ⇒ defaultRole. */
    roleMapping: jsonb("role_mapping").notNull().default({}),
    defaultRole: oidcDefaultRole("default_role").notNull().default("viewer"),
    /** ONLY enabled for mock/dev. Prod Keycloak is always https. */
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
 * Anchors `(connector, subject)` → user. THIS IS THE IDENTITY ANCHOR, not email.
 *
 * WHY THIS TABLE HAS TO EXIST: `users` is a GLOBAL table (see the note above), while each
 * team configures its own OIDC connector — any team can point it at its own Keycloak and
 * declare whatever `email` claim it likes. Linking a new identity to an existing user by
 * email ⇒ team B could mint a session carrying the real userId of someone who only belongs
 * to team A. The IdP's `sub` is the one thing that's stable and cannot be faked by ANOTHER
 * team (it only has meaning within this connector's scope), so it's the lookup key; email
 * is only used on the first login, under two strict conditions (see `oidc/connector.ts`).
 *
 * NO `auth_lookup` policy: every access here happens AFTER the team is already known (the
 * connector's team), i.e. always through `withTenant` + the app role. The `testkite_auth`
 * path never needs to read this table, so it isn't granted read access to it.
 */
export const idnOidcIdentities = pgTable(
  "idn_oidc_identities",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id").notNull(),
    /** The IdP's `sub` — an immutable identifier, unchanged when the user changes their email. */
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("idn_oidc_identities_team_id_unique").on(t.teamId, t.id),
    // One subject of one connector maps to EXACTLY one user.
    uniqueIndex("idn_oidc_identities_connector_subject_uidx").on(t.connectorId, t.subject),
    index("idn_oidc_identities_team_idx").on(t.teamId),
    // Composite FK: the anchor can never point at another team's connector (L2 layer).
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
 * The state of one OIDC login attempt. Lives in the DB rather than a cookie/process
 * memory: (a) there are multiple API instances, (b) state must be SINGLE-USE —
 * `consumed_at` is what blocks replay.
 * `code_verifier` is a short-lived (10-minute) secret, cleaned up by a job or TTL.
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
    // Composite FK: state can never point at another team's connector (L2 layer).
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
