/**
 * Module governance — quota_limits (ownership.json). Bản M2 là bản TỐI THIỂU đủ cho
 * onboarding: 6 chỉ số của blueprint §3, chưa có reservation/ledger (M5).
 *
 * `team_id` vừa là PK vừa là khoá tenant: mỗi team đúng MỘT bộ hạn mức, nên
 * `ON CONFLICT (team_id) DO NOTHING` của seed là phép idempotent do DB canh, không
 * phải do người gọi nhớ kiểm tra.
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
