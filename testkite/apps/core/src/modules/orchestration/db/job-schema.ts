/**
 * `job_runs` — THE QUEUE OF RECORD (blueprint §5). There is no second queue: no Redis list,
 * no BullMQ job for test execution. A row here is the single truth about who owns a chain
 * right now, and `lease_epoch` is the fence that makes ownership provable.
 *
 * Ordering key = (priority DESC, queue_seq ASC, id ASC). `id` is in the key ONLY as a
 * tiebreak: requeue-at-team-head computes MIN(queue_seq)-1, and two reapers racing would
 * produce a tie (measured, spike 2026-08-29 §4). The reaper only ever runs inside the
 * leader's tick, so a tie should not happen — the tiebreak makes the order deterministic
 * even if it somehow does.
 *
 * TWO policies, two roles. `tenant_isolation` serves the request path; `dispatch_all` serves
 * the claim path, which cannot filter by tenant because the tenant is what the claim
 * RETURNS. Permissive policies are OR-ed, and — measured on 2026-08-29 — that OR reaches
 * across INHERITED roles too, so `testkite_dispatch` must never be granted to
 * `testkite_app`; see DISPATCH_ROLE in kernel/db/schema.ts.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, dispatchRole } from "../../kernel/index.js";
import { orcRuns } from "./run-schema.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const jobStatus = pgEnum("job_status", [
  "pending",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rejected_quota",
  "unknown_after_restore",
]);
export const jobKind = pgEnum("job_kind", [
  "chain",
  "element_verify",
  "capture_session",
  "env_probe",
]);

export const jobRuns = pgTable(
  "job_runs",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    chainKey: text("chain_key").notNull(),
    lane: text("lane").notNull().default("batch"),
    jobKind: jobKind("job_kind").notNull().default("chain"),
    status: jobStatus("status").notNull().default("pending"),
    /** Bumped on EVERY ownership change. A worker holding an older value writes 0 rows => 409. */
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    /** Ordering position. Requeue rewrites it to MIN(queue_seq)-1 within the team. */
    queueSeq: bigint("queue_seq", { mode: "number" }).notNull(),
    /** cost = clamp(ceil(steps/10), 1, 8) — stamped at compile time, read by the M5 DRR. */
    cost: integer("cost").notNull().default(1),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /**
     * Quarantine after 2 OOM (blueprint §5) is a COLUMN, not a status: a quarantined job is
     * still `pending` for every read path, it is only invisible to the dispatcher. Adding an
     * enum value would have rippled into the contract's JOB_STATUSES and the run DTO.
     */
    oomCount: integer("oom_count").notNull().default(0),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("job_runs_team_id_unique").on(t.teamId, t.id),
    unique("job_runs_team_run_chain_unique").on(t.teamId, t.runId, t.chainKey),
    index("job_runs_team_run_idx").on(t.teamId, t.runId, t.status),
    foreignKey({
      name: "job_runs_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
    }),
    check("job_runs_lane_check", sql`${t.lane} IN ('interactive','batch')`),
    check("job_runs_attempt_check", sql`${t.attempt} >= 1`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
    // The claim path does not know the tenant yet — see withDispatchRole().
    pgPolicy("dispatch_all", {
      as: "permissive",
      for: "all",
      to: dispatchRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();
