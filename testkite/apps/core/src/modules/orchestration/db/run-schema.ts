/**
 * Module orchestration — the run aggregate (ownership.json: orc_*).
 *
 * `orc_run_plans` is APPEND-ONLY AT THE PRIVILEGE LAYER (see the grants migration): a frozen
 * plan is the only thing the worker ever executes, so "immutable" cannot be a convention that
 * code happens to respect — the database has to refuse the UPDATE.
 *
 * The file is called `run-schema.ts`, not `schema.ts`, because `egress_policies` already owns
 * that name inside this module; drizzle.config.ts names this file explicitly so drizzle-kit
 * still generates its DDL (unlike governance's `audit-schema.ts`, which is hand-written on
 * purpose because it is partitioned).
 */
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";
import { projects, users } from "../../identity/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const runLane = pgEnum("run_lane", ["interactive", "batch"]);
export const runStatus = pgEnum("run_status", ["compiling", "queued", "running", "finished"]);
export const runVerdict = pgEnum("run_verdict", [
  "pending",
  "passed",
  "failed",
  "compile_error",
  "blocked",
  "aborted_early",
  "cancelled",
]);
export const runPin = pgEnum("run_pin", ["ready", "latest"]);
export const diagnosticSeverity = pgEnum("diagnostic_severity", ["error", "warning"]);

export const orcRuns = pgTable(
  "orc_runs",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    lane: runLane("lane").notNull().default("batch"),
    status: runStatus("status").notNull().default("compiling"),
    verdict: runVerdict("verdict").notNull().default("pending"),
    /** NULL until phase 7 froze a plan; absent forever when verdict = compile_error. */
    planHash: text("plan_hash"),
    requestedBy: uuid("requested_by").notNull(),
    pin: runPin("pin").notNull(),
    chainTotal: integer("chain_total").notNull().default(0),
    chainDone: integer("chain_done").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_runs_team_id_unique").on(t.teamId, t.id),
    index("orc_runs_team_created_idx").on(t.teamId, t.createdAt.desc()),
    index("orc_runs_team_status_idx").on(t.teamId, t.status, t.createdAt.desc()),
    foreignKey({
      name: "orc_runs_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    foreignKey({ name: "orc_runs_user_fk", columns: [t.requestedBy], foreignColumns: [users.id] }),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

export const orcRunPlans = pgTable(
  "orc_run_plans",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    /** Lowercase SHA-256 hex from the compiler's phase 7 — the plan's identity. */
    contentHash: text("content_hash").notNull(),
    planFormatVersion: integer("plan_format_version").notNull(),
    plan: jsonb("plan").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_run_plans_team_id_unique").on(t.teamId, t.id),
    unique("orc_run_plans_team_run_unique").on(t.teamId, t.runId),
    index("orc_run_plans_team_hash_idx").on(t.teamId, t.contentHash),
    foreignKey({
      name: "orc_run_plans_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
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

export const orcCompileDiagnostics = pgTable(
  "orc_compile_diagnostics",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    severity: diagnosticSeverity("severity").notNull(),
    code: text("code").notNull(),
    caseId: text("case_id").notNull(),
    stepOrdinal: integer("step_ordinal"),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_compile_diagnostics_team_id_unique").on(t.teamId, t.id),
    index("orc_compile_diagnostics_team_run_idx").on(t.teamId, t.runId),
    foreignKey({
      name: "orc_compile_diagnostics_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
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
