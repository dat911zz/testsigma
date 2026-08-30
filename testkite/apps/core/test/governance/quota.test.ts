/**
 * Quota reserve/refund (module governance, table `usage_counters`) at layers L2/L2.5.
 *
 * The whole guarantee lives in ONE statement — `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE used + n <= limit RETURNING used` — so what is worth pinning down is the
 * behaviour phase 0 leans on: the cap actually holds, a failed compile gives the slot
 * back, a retried refund cannot mint quota, and two teams never share a counter.
 *
 * Deviations from the plan (Task 3 Step 1), all deliberate:
 *  - `beforeAll` + `reset()` instead of `beforeEach(makeTestDb)`. A fresh PGlite costs
 *    ~2.3s plus ~3.6s of migrations; the harness reset is ~2ms. Same shape as every
 *    other DB test in this repo.
 *  - the underflow case reserves first and then refunds TWICE. The plan's version
 *    refunded with no counter row at all, which passes even if `GREATEST(...,0)` is
 *    deleted; the retry-of-an-error-path case is the one that actually exercises it.
 *    The "nothing to refund" case is kept as its own test.
 *  - two extra cases: a limit of 0 with no counter row yet, and a team with no quota row
 *    at all. Both land on the INSERT arm of the statement, which the plan's four cases
 *    never reach, and Task 4 ("refuses over-quota BEFORE compiling anything") depends on
 *    the first one.
 *  - two isolation cases (cross-team invisibility, fail-closed without `app.team_id`),
 *    which every tenant-scoped table in this repo carries.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import {
  refundRunSlot,
  reserveRunSlot,
  type ReserveResult,
} from "../../src/modules/governance/quota.js";

describe("run quota reserve/refund", () => {
  let t: TestDb;
  const now = new Date("2026-08-30T09:00:00Z");

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it("grants up to the team's max_runs_per_day and then refuses", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(
      sql`UPDATE quota_limits SET max_runs_per_day = 3 WHERE team_id = ${a.teamId}`,
    );
    const results: ReserveResult[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now })));
    }
    expect(results.map((r) => r.granted)).toEqual([true, true, true, false]);
    expect(results[2]?.used).toBe(3);
    // A refusal must report where the team actually stands, not a guess.
    expect(results[3]).toMatchObject({ used: 3, limit: 3 });
  });

  it("gives the slot back when compilation fails, so a broken test does not burn the day's budget", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(
      sql`UPDATE quota_limits SET max_runs_per_day = 1 WHERE team_id = ${a.teamId}`,
    );
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect(
      (await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }))).granted,
    ).toBe(false);
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    expect(
      (await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }))).granted,
    ).toBe(true);
  });

  it("does not invent a counter row when there is nothing to refund", async () => {
    const [a] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    const r = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM usage_counters`),
    );
    expect(Number(r.rows[0]?.["n"])).toBe(0);
  });

  it("never lets a refund push the counter below zero", async () => {
    const [a] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    // Two refunds for one reservation: the compile-error path can be retried, and a retry
    // must not mint free quota (nor trip the `used >= 0` CHECK).
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    const r = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT coalesce(max(used), 0)::int u FROM usage_counters`),
    );
    expect(Number(r.rows[0]?.["u"])).toBe(0);
  });

  it("counts each team's runs separately", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    const forB = await t.asTeamCtx(b.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect(forB.used).toBe(1);
  });

  it("counts a reservation against the UTC day of `now`, not the process timezone", async () => {
    const [a] = await t.seedTwoTeams();
    // 23:30 in UTC+07:00 is still 2026-08-30 in UTC; a local-date implementation would
    // open a second day's budget here.
    const lateLocalEvening = new Date("2026-08-31T06:30:00+07:00");
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    const second = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      reserveRunSlot(tx, ctx, { now: lateLocalEvening }),
    );
    expect(second.used).toBe(2);
    const r = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM usage_counters`),
    );
    expect(Number(r.rows[0]?.["n"])).toBe(1);
  });

  it("refuses when the limit is zero, even though no counter row exists yet", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(
      sql`UPDATE quota_limits SET max_runs_per_day = 0 WHERE team_id = ${a.teamId}`,
    );
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect(res).toMatchObject({ granted: false, used: 0, limit: 0 });
    const r = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM usage_counters`),
    );
    expect(Number(r.rows[0]?.["n"]), "a refused reservation must not leave a row").toBe(0);
  });

  it("refuses a team that has no quota row at all instead of treating it as unlimited", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(sql`DELETE FROM quota_limits WHERE team_id = ${a.teamId}`);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect(res.granted).toBe(false);
  });

  it("keeps one team's counters invisible to the other", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    const seen = await t.asTeam(b.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM usage_counters`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });

  it("returns nothing when app.team_id was never set (fail-closed)", async () => {
    const [a] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    const seen = await t.asAppRoleWithoutTenant((tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM usage_counters`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });
});
