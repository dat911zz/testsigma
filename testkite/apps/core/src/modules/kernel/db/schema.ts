/**
 * Kernel module — krn_ tables (ownership.json).
 *
 * krn_outbox is the transactional outbox: every BACKWARD/SIDEWAYS call across the module DAG goes through here.
 * RLS is NOT enabled: the relay must read events for EVERY team. Isolation is enforced by
 * role instead — testkite_app is INSERT-only (no SELECT), testkite_relay reads/writes (Task 8).
 */
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Role used by the request path. MUST be non-superuser and NOBYPASSRLS:
 * spike 2026-08-27 proved a superuser bypasses RLS even with FORCE.
 *
 * Lives in kernel, not identity: this is DB infrastructure (a twin of RELAY_ROLE
 * right below), and `kernel/db/tenant.ts` must `SET LOCAL ROLE` to it. Kernel is the
 * ROOT of the DAG (module-dag.json), so it may not import identity — putting this constant in
 * identity would force kernel to import backward, exactly what eslint-boundaries blocks.
 */
export const APP_ROLE = "testkite_app" as const;
export const appRole = pgRole(APP_ROLE);

export const RELAY_ROLE = "testkite_relay" as const;
export const relayRole = pgRole(RELAY_ROLE);

/**
 * Role for the AUTHENTICATION PATH. Exists because of a real deadlock (spike 2026-08-28):
 * RLS fail-closed works exactly as designed ⇒ `testkite_app`, before `app.team_id` is set,
 * reads `api_tokens` as 0 rows, but getting `app.team_id` requires looking up the token
 * first. This role breaks that loop with the narrowest privilege possible: SELECT ONLY, on
 * api_tokens/memberships/idn_oidc_connectors/idn_oidc_login_states, via each table's own
 * `auth_lookup` policy — it does NOT BYPASSRLS.
 *
 * `users` is the ONE EXCEPTION: it is GLOBAL (one person, many teams) and NOT
 * tenant-scoped (identity/db/schema.ts), so it has no RLS — no `tenant_isolation` policy
 * and no `auth_lookup` policy either. This role's read access to it comes from a plain
 * GRANT (migration 0016), the same as every other role that can read `users` at all.
 */
export const AUTH_ROLE = "testkite_auth" as const;
export const authRole = pgRole(AUTH_ROLE);

export const krnOutbox = pgTable(
  "krn_outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    teamId: text("team_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("krn_outbox_ready_idx").on(t.availableAt, t.id)],
);

export const krnOutboxConsumed = pgTable(
  "krn_outbox_consumed",
  {
    outboxId: bigint("outbox_id", { mode: "bigint" })
      .notNull()
      .references(() => krnOutbox.id, { onDelete: "cascade" }),
    consumer: text("consumer").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite PK: several independent consumers consume the same event, each pair exactly once.
    primaryKey({ name: "krn_outbox_consumed_pk", columns: [t.outboxId, t.consumer] }),
  ],
);
