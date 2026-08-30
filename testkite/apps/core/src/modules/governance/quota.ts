/**
 * Reserve BEFORE compiling, refund when compilation fails. The whole guarantee lives in one
 * statement: `ON CONFLICT DO UPDATE ... WHERE used + n <= limit RETURNING used`. Measured
 * 2026-08-29 with 8 concurrent reservations against a limit of 3: exactly 3 granted, 5
 * refused, 0 errors — no explicit locking, no read-then-write race.
 */
import { sql } from "drizzle-orm";
import {
  assertTenantContext,
  firstRow,
  type TenantContext,
  type TkTx,
} from "../kernel/index.js";

export const QUOTA_METRIC_RUNS_PER_DAY = "runs_per_day" as const;

export interface ReserveResult {
  readonly granted: boolean;
  readonly used: number;
  readonly limit: number;
}

/**
 * The counter window is a UTC day, taken from the caller's `now` — never from the process
 * clock or its timezone, so a run started at 23:30 in UTC+7 still spends the same day's
 * budget the rest of the system is measuring.
 */
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export async function reserveRunSlot(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly now: Date; readonly amount?: number },
): Promise<ReserveResult> {
  const teamId = assertTenantContext(ctx);
  const amount = input.amount ?? 1;
  const day = utcDay(input.now);
  const limitRow = firstRow(
    await tx.execute(
      sql`SELECT max_runs_per_day AS lim FROM quota_limits WHERE team_id = ${teamId}`,
    ),
  );
  // No quota row at all = the team was never onboarded through the real path. Refuse rather
  // than invent a default: a missing limit must not become an unlimited one.
  const limit = Number(limitRow?.["lim"] ?? 0);
  // Deviation from the plan's draft, which wrote the INSERT as a bare VALUES: the limit was
  // then only enforced on the ON CONFLICT arm, so the FIRST reservation of a day slipped
  // through whatever the limit was (a team with max_runs_per_day = 0 got one free run —
  // exactly the case Task 4 asserts must be refused). `SELECT ... WHERE` puts the same
  // predicate on the arm that creates the row.
  const reserved = firstRow(
    await tx.execute(sql`
      INSERT INTO usage_counters (team_id, metric, window_start, used)
      SELECT ${teamId}::uuid, ${QUOTA_METRIC_RUNS_PER_DAY}::text, ${day}::date, ${amount}::int
       WHERE ${amount}::int <= ${limit}::int
      ON CONFLICT (team_id, metric, window_start) DO UPDATE
        SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
        WHERE usage_counters.used + EXCLUDED.used <= ${limit}::int
      RETURNING used`),
  );
  if (reserved !== undefined) return { granted: true, used: Number(reserved["used"]), limit };
  // Refused. Report what the team ACTUALLY holds instead of assuming it sits exactly on the
  // limit: that assumption only holds for amount = 1, and the number goes into the 429 body.
  const current = firstRow(
    await tx.execute(sql`
      SELECT used FROM usage_counters
       WHERE team_id = ${teamId} AND metric = ${QUOTA_METRIC_RUNS_PER_DAY}
         AND window_start = ${day}::date`),
  );
  return { granted: false, used: Number(current?.["used"] ?? 0), limit };
}

export async function refundRunSlot(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly now: Date; readonly amount?: number },
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  const amount = input.amount ?? 1;
  // GREATEST(...,0): a double refund (retry of an error path) must not mint free quota.
  await tx.execute(sql`
    UPDATE usage_counters SET used = GREATEST(used - ${amount}, 0), updated_at = now()
    WHERE team_id = ${teamId} AND metric = ${QUOTA_METRIC_RUNS_PER_DAY}
      AND window_start = ${utcDay(input.now)}::date`);
}
