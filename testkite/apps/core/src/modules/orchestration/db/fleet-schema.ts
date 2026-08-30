/**
 * Fleet infrastructure tables. Parts 1-3: `orc_dispatcher_lease` (leadership as a ROW, on
 * purpose), plus the two credentials a zero-credential worker holds — `orc_workers` and
 * `orc_run_tokens`. `orc_run_events` joins this file in Task 10.
 *
 * Why not pg_advisory_lock (spike 2026-08-29 §3, numbers measured in this sandbox):
 *  - invisible: pg_locks cannot say WHO holds it, since when, or when it last ticked, and the
 *    blueprint's §5 observability list demands a "dispatcher dead-man" alert;
 *  - unbounded worst case: a network-partitioned leader keeps the lock until TCP keepalive
 *    kills the session — the server default here is 7200s idle + 9x75s = ~2h07 with no
 *    dispatcher, and on a managed Postgres those are not always ours to change;
 *  - it leaks through a connection pool: measured that pg.Pool handed back the SAME session
 *    after release() and pg_try_advisory_lock succeeded a second time, so two processes both
 *    believed they led, with no signal anywhere.
 * A TTL row costs one UPDATE every 2.5s and fails over in ~TTL (measured 5032ms at TTL=5s).
 * Leadership is only an OPTIMISATION here — dispatch itself is already safe under split brain
 * thanks to SKIP LOCKED plus the conditional epoch UPDATE — so trading a ~TTL failover for a
 * bounded worst case and a readable row is the right side of the deal.
 *
 * There is exactly ONE row, forever: `id smallint PRIMARY KEY` with a CHECK pinning it to 1.
 * This table is NOT tenant-scoped and carries NO RLS — it is fleet infrastructure, and the
 * migration grants it to `testkite_dispatch` alone (the request-path role gets nothing, so a
 * leaked app connection cannot even read who leads, let alone appoint itself).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, authRole } from "../../kernel/index.js";
import { jobRuns } from "./job-schema.js";

/**
 * bytea: drizzle 0.45 still has no builtin builder. Declared here rather than imported from
 * identity/db/schema.ts, which does not export it and which orchestration may not reach into
 * anyway (ownership.json) — the COLUMN TYPE is what has to match api_tokens, not the helper.
 */
const customBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Identical to every other tenant predicate in the system. NULLIF is not optional: `RESET
 * app.team_id` leaves an EMPTY STRING behind, and `''::uuid` throws 22P02 instead of failing closed. */
const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const orcDispatcherLease = pgTable(
  "orc_dispatcher_lease",
  {
    id: smallint("id").primaryKey().default(1),
    holder: text("holder").notNull(),
    /** Bumped ONLY on takeover, never on renew — a stable epoch means "still the same leader". */
    epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
    /** When the CURRENT leader took over. Untouched by a renew, so it reads as leader uptime. */
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("orc_dispatcher_lease_singleton", sql`${t.id} = 1`)],
);

/**
 * `orc_workers` — the fleet roster AND the worker credential, in one row.
 *
 * NOT tenant-scoped: a worker serves every tenant in turn, so there is no `team_id` to write a
 * policy about and the table carries no RLS. Access is by ROLE alone (like krn_outbox), which
 * makes the GRANT in the migration the entire access control: `testkite_dispatch` may read and
 * write it, the request-path role gets nothing at all — not even SELECT, because this row holds
 * the SHA-256 of a live credential and the id of every machine in the fleet.
 *
 * The token hash lives on the worker row on purpose: "delete the worker" and "revoke its
 * credential" are then the same write and can never drift apart.
 */
export const orcWorkers = pgTable(
  "orc_workers",
  {
    id: text("id").primaryKey(),
    hostname: text("hostname").notNull(),
    lane: text("lane").notNull(),
    capacity: integer("capacity").notNull(),
    /** Set by an operator (or a rolling upgrade): the worker finishes what it holds and claims nothing new. */
    drain: boolean("drain").notNull().default(false),
    /** First 4 bytes of the secret, in the clear, so logs and alerts can NAME a token without holding it. */
    prefix: text("prefix").notNull(),
    tokenHash: customBytea("token_hash").notNull(),
    /** Expiry is MANDATORY here too — there is no permanent credential anywhere in this system. */
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    freeSlots: integer("free_slots").notNull().default(0),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orc_workers_hash_uidx").on(t.tokenHash),
    check("orc_workers_lane_check", sql`${t.lane} IN ('interactive','batch')`),
  ],
);

/**
 * `orc_run_tokens` — the only credential a worker ever holds against a tenant's data, and it is
 * deliberately NOT a tenant credential: it names one job, one attempt, one epoch, it carries no
 * scopes and no user, and it dies with the lease (expiry, or revoked the instant ownership moves).
 *
 * Two policies, exactly like api_tokens (M2): verifying a token has to happen BEFORE the tenant
 * is known — the row is what ANSWERS "which tenant?" — so `testkite_auth` gets a SELECT-only
 * `auth_lookup` policy, while the request path keeps `tenant_isolation`. The composite FK
 * (team_id, job_run_id) is what makes "a token for another team's job" unrepresentable rather
 * than merely unchecked.
 */
export const orcRunTokens = pgTable(
  "orc_run_tokens",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    jobRunId: uuid("job_run_id").notNull(),
    attempt: integer("attempt").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    workerId: text("worker_id").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: customBytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_run_tokens_team_id_unique").on(t.teamId, t.id),
    index("orc_run_tokens_team_job_idx").on(t.teamId, t.jobRunId, t.attempt),
    uniqueIndex("orc_run_tokens_hash_uidx").on(t.tokenHash),
    foreignKey({
      name: "orc_run_tokens_job_fk",
      columns: [t.teamId, t.jobRunId],
      foreignColumns: [jobRuns.teamId, jobRuns.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
    // The auth path: SELECT only, NO withCheck => this role can write nothing.
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();
