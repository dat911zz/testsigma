/**
 * Module governance — quota_limits (ownership.json). The M2 build is the MINIMUM
 * needed for onboarding: the 6 metrics from blueprint §3, no reservation/ledger yet (M5).
 *
 * `team_id` is both the PK and the tenant key: each team gets exactly ONE set of
 * limits, so the seed's `ON CONFLICT (team_id) DO NOTHING` is idempotency guarded by the
 * DB, not something the caller has to remember to check.
 */
import { sql } from "drizzle-orm";
import { index, integer, pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const quotaLimits = pgTable(
  "quota_limits",
  {
    teamId: uuid("team_id").primaryKey(),
    maxConcurrentContexts: integer("max_concurrent_contexts").notNull().default(8),
    maxRunsPerDay: integer("max_runs_per_day").notNull().default(200),
    maxStorageGb: integer("max_storage_gb").notNull().default(50),
    maxAiTokensPerMonth: integer("max_ai_tokens_per_month").notNull().default(1_000_000),
    maxMembers: integer("max_members").notNull().default(25),
    maxProjects: integer("max_projects").notNull().default(10),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quota_limits_team_idx").on(t.teamId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
