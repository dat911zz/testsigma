/**
 * Module governance — usage_counters (ownership.json). M3 only needs ONE metric
 * (runs_per_day); the usage_ledger and the reservation model for concurrent contexts are M5.
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const usageCounters = pgTable(
  "usage_counters",
  {
    teamId: uuid("team_id").notNull(),
    metric: text("metric").notNull(),
    /** UTC day for runs_per_day; M5 will add month-windowed metrics on the same shape. */
    windowStart: date("window_start").notNull(),
    used: integer("used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * The PRIMARY KEY is the read index too. There was a second `usage_counters_team_idx` over
     * the same three columns in the same order — byte-for-byte the btree Postgres already builds
     * for the key — so it doubled the write cost of every quota reservation and answered no
     * query the PK could not. Dropped in 0042; `schema-0042.test.ts` reads `pg_indexes` back.
     */
    primaryKey({ columns: [t.teamId, t.metric, t.windowStart] }),
    check("usage_counters_used_check", sql`${t.used} >= 0`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
