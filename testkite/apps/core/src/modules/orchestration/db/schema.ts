/**
 * Module orchestration — egress_policies (the minimal M2 build for onboarding).
 * blueprint §5: hardening tier 0 = per-tenant default-deny egress, but turned on in
 * OBSERVE mode for 14 days before enforcing (S8) — the seed lives inside onboarding's own transaction.
 *
 * DELIBERATE DEVIATION from the schema block in the plan (Task 10, Step 3): adds
 * `unique(team_id)`. The plan wrote the seed as `ON CONFLICT (team_id, id) DO NOTHING`, but
 * `id` is `gen_random_uuid()` so that pair NEVER collides — calling onboard a second time
 * would silently add a second egress policy for the same team, exactly what this task (and
 * the "does NOT duplicate anything" test) forbids. In M2 each tenant gets exactly ONE egress
 * policy, so let the DB guard that instead of relying on the caller remembering to check
 * first. When M5 needs multiple policies per team, drop this constraint at the same time a real distinguishing key is added.
 */
import { sql } from "drizzle-orm";
import { index, pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const egressMode = pgEnum("egress_mode", ["observe", "enforce"]);

export const egressPolicies = pgTable(
  "egress_policies",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    mode: egressMode("mode").notNull().default("observe"),
    allowlist: text("allowlist").array().notNull(),
    observeUntil: timestamp("observe_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("egress_policies_team_id_unique").on(t.teamId, t.id),
    unique("egress_policies_team_unique").on(t.teamId),
    index("egress_policies_team_idx").on(t.teamId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
