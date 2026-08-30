/**
 * The CONCURRENCY test layer for the RUN QUOTA — runs ONLY on REAL Postgres.
 *
 * WHY THIS DOESN'T LIVE IN THE PGlite LAYER: `test/governance/quota.test.ts` reserves in a
 * plain `for` loop, one `await` after another, against PGlite's single wasm connection. That
 * proves the arithmetic, never the atomicity: on PGlite two "parallel" `withTenant` calls
 * queue sequentially, so a race assertion made there is a FALSE GREEN (see
 * `test/harness/realpg.ts`). `reserveRunSlot` claims the cap holds with no explicit locking —
 * that claim only means something with several real connections hitting the same counter row.
 *
 * Two regressions this file exists to catch, both of which the sequential layer lets through:
 *  1. splitting the single `INSERT ... ON CONFLICT DO UPDATE ... WHERE used + n <= limit` into
 *     a read-then-write pair ⇒ more grants than the limit allows;
 *  2. "simplifying" the INSERT arm back to the plan's draft `VALUES (...)`, which drops the
 *     limit predicate from the row-creating arm ⇒ the FIRST reservation of a day is granted
 *     whatever the limit is (a team on `max_runs_per_day = 0` gets one free run). Measured:
 *     with that draft restored, the limit-0 case below goes red at `1 to be 0`.
 *
 * Every parallel block goes through a gate that opens only once ALL parties have BEGUN their
 * transaction. Without it `Promise.all` is not parallel at all on a cold pool: the second
 * `withTenant` has to open a brand-new physical connection (TCP + auth) and only reads after
 * the first has already COMMITted — the same false green documented in promote-lock.test.ts.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the whole suite skips (`eval "$(scripts/test-pg.sh start)"` to
 * spin up a temporary cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof
 * is collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import {
  refundRunSlot,
  reserveRunSlot,
  type ReserveResult,
} from "../../src/modules/governance/quota.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/**
 * Number of genuinely parallel connections. Equal to the harness pool's `max`, so every party
 * really does hold its own connection before the gate opens — a larger number would leave the
 * last ones queueing for a connection while the others wait at the gate, i.e. a deadlock.
 */
const PARALLEL = 8;

/** A blocking gate: opens once `n` parties have arrived. Forces every transaction to OPEN before any writes. */
function makeGate(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

describeRealPg("run quota under REAL contention (real Postgres, multiple connections)", () => {
  let r: RealDb;
  let teamA = "";
  let teamB = "";
  const now = new Date("2026-08-30T09:00:00Z");

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE usage_counters, quota_limits, memberships, projects, teams, users, organizations
      RESTART IDENTITY CASCADE`);
    const org = await r.db.execute(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const orgId = String(org.rows[0]?.["id"]);
    const seedTeam = async (label: string): Promise<string> => {
      const team = await r.db.execute(
        sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},${label},${label}) RETURNING id`,
      );
      const teamId = String(team.rows[0]?.["id"]);
      await r.db.execute(sql`INSERT INTO quota_limits (team_id) VALUES (${teamId})`);
      return teamId;
    };
    teamA = await seedTeam("a");
    teamB = await seedTeam("b");
  });

  const setLimit = async (teamId: string, limit: number): Promise<void> => {
    await r.db.execute(
      sql`UPDATE quota_limits SET max_runs_per_day = ${limit} WHERE team_id = ${teamId}`,
    );
  };

  /** `n` reservations that all begin their transaction first, then hit the counter together. */
  const reserveInParallel = async (
    teamId: string,
    n: number,
  ): Promise<readonly ReserveResult[]> => {
    const gate = makeGate(n);
    return Promise.all(
      Array.from({ length: n }, () =>
        withTenant(r.db, { teamId }, async (tx) => {
          await gate();
          return reserveRunSlot(tx, { teamId }, { now });
        }),
      ),
    );
  };

  const counterRows = async (
    teamId: string,
  ): Promise<readonly { readonly used: number }[]> => {
    const rows = await r.db.execute(
      sql`SELECT used FROM usage_counters WHERE team_id = ${teamId} ORDER BY window_start`,
    );
    return rows.rows.map((row) => ({ used: Number(row["used"]) }));
  };

  it(`${PARALLEL} reservations at once against a limit of 3: EXACTLY 3 granted, one counter row at 3`, async () => {
    await setLimit(teamA, 3);

    const results = await reserveInParallel(teamA, PARALLEL);

    const granted = results.filter((res) => res.granted);
    expect(granted.length, "the cap must hold under contention, not just sequentially").toBe(3);
    expect(results.length - granted.length).toBe(PARALLEL - 3);
    // The winners hand out 1, 2, 3 — every granted `used` is distinct, so no two callers were
    // told they hold the same slot (a read-then-write implementation duplicates them).
    expect([...granted.map((res) => res.used)].sort((x, y) => x - y)).toEqual([1, 2, 3]);
    for (const res of results) expect(res.limit).toBe(3);
    // The DB is the authority: one row for the day, holding exactly the number handed out.
    expect(await counterRows(teamA)).toEqual([{ used: 3 }]);
    // A refusal reports what the team actually holds — the 429 body carries this number.
    for (const res of results.filter((x) => !x.granted)) expect(res.used).toBe(3);
  });

  it(`${PARALLEL} reservations at once against a limit of 0 with NO counter row yet: 0 granted, no row created`, async () => {
    await setLimit(teamA, 0);

    const results = await reserveInParallel(teamA, PARALLEL);

    // The row-creating arm of the statement carries the limit predicate too. With the plan's
    // draft `VALUES (...)` arm, exactly one of these comes back granted — a free run for a
    // team whose quota is zero, which is the case Task 4 refuses BEFORE compiling anything.
    expect(results.filter((res) => res.granted).length).toBe(0);
    for (const res of results) expect(res).toMatchObject({ granted: false, used: 0, limit: 0 });
    expect(await counterRows(teamA), "a refused reservation must not leave a row").toEqual([]);
  });

  it(`${PARALLEL} refunds at once for a single reservation: the counter stops at 0, never below`, async () => {
    await setLimit(teamA, 10);
    await withTenant(r.db, { teamId: teamA }, (tx) =>
      reserveRunSlot(tx, { teamId: teamA }, { now }),
    );

    // Every error path may be retried, and several retries can overlap. GREATEST(...,0) has to
    // survive that without tripping the `used >= 0` CHECK — a raised constraint error here
    // would surface as a 500 on a path whose whole job is cleaning up after a failure.
    const gate = makeGate(PARALLEL);
    await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        withTenant(r.db, { teamId: teamA }, async (tx) => {
          await gate();
          await refundRunSlot(tx, { teamId: teamA }, { now });
        }),
      ),
    );

    expect(await counterRows(teamA)).toEqual([{ used: 0 }]);
  });

  it("two teams reserving at once keep separate counters: neither eats the other's budget", async () => {
    await setLimit(teamA, 2);
    await setLimit(teamB, 2);
    const half = PARALLEL / 2;
    const gate = makeGate(PARALLEL);
    const reserveFor = (teamId: string) =>
      withTenant(r.db, { teamId }, async (tx) => {
        await gate();
        return reserveRunSlot(tx, { teamId }, { now });
      });

    const results = await Promise.all([
      ...Array.from({ length: half }, () => reserveFor(teamA)),
      ...Array.from({ length: half }, () => reserveFor(teamB)),
    ]);

    expect(results.filter((res) => res.granted).length).toBe(4);
    expect(await counterRows(teamA)).toEqual([{ used: 2 }]);
    expect(await counterRows(teamB)).toEqual([{ used: 2 }]);
  });
});
