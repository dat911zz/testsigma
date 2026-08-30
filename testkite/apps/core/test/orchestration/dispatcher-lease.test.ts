/**
 * Leader election as a ROW with a TTL — the unit half, on PGlite.
 *
 * What this layer proves is the STATE MACHINE: who wins, what a renew is allowed to change,
 * when a challenger may take over, and that a leader which was already replaced can neither
 * renew nor free its successor's lease. Whether five simultaneous candidates really produce
 * exactly one leader is a question about contention, and PGlite's single wasm connection
 * cannot answer it — that half lives in test/concurrency/dispatcher-leader.test.ts.
 *
 * Why a row and not pg_advisory_lock (spike 2026-08-29 §3): an advisory lock is invisible to
 * the dead-man alert, keeps leadership for ~2h07 behind a network partition (the server's
 * tcp_keepalives_idle is 7200s), and leaks through pg.Pool — measured, two processes both
 * believing they lead. A row costs one UPDATE every 2.5s and fails over in ~TTL.
 *
 * Deliberate deviations from the plan's block:
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as reaper.test.ts / job-queue.test.ts).
 *  - `held()` instead of `first?.epoch`: an assertion made on `undefined` proves nothing.
 *  - four tests the plan's six leave out: the cold-cluster read (nobody has ever led), the
 *    GRANT (the request-path role must not even be able to LOOK at leadership), the singleton
 *    CHECK, and what a renew moves versus what it must leave alone.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { firstRow } from "../../src/modules/kernel/index.js";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  acquireOrRenewLease,
  readLease,
  releaseLease,
  type DispatcherLease,
} from "../../src/modules/orchestration/dispatcher/lease.js";

/** The lease, or a loud failure — `null` means "somebody else leads" and must never be asserted on. */
function held(lease: DispatcherLease | null): DispatcherLease {
  if (lease === null) throw new Error("expected this candidate to hold the lease, got null");
  return lease;
}

describe("dispatcher leader election", () => {
  let t: TestDb;
  let a: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a] = await t.seedTwoTeams();
  });

  /** The raw row, read the only way production can read it: as the dispatch role. */
  const leaseRow = async (): Promise<Record<string, unknown> | undefined> =>
    t.asDispatchRole(async (db) =>
      firstRow(
        await db.execute(sql`SELECT id, holder, epoch, acquired_at, last_tick_at, expires_at
                               FROM orc_dispatcher_lease`),
      ),
    );

  it("gives the lease to the first caller and refuses the second", async () => {
    expect(await acquireOrRenewLease(t.db, { holder: "d1" })).toMatchObject({
      holder: "d1",
      epoch: 1,
    });
    expect(await acquireOrRenewLease(t.db, { holder: "d2" })).toBeNull();
  });

  it("lets the holder renew without changing the epoch — renewing is not a takeover", async () => {
    const first = held(await acquireOrRenewLease(t.db, { holder: "d1" }));
    const again = held(await acquireOrRenewLease(t.db, { holder: "d1" }));
    expect(again.epoch).toBe(first.epoch);
  });

  it("hands the lease to a challenger once the TTL expires, with a NEW epoch", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 });
    const taken = await acquireOrRenewLease(t.db, { holder: "d2" });
    expect(taken).toMatchObject({ holder: "d2", epoch: 2 });
  });

  it("fences the old leader: it cannot renew or release after being taken over", async () => {
    const first = held(await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 }));
    await acquireOrRenewLease(t.db, { holder: "d2" });
    expect(await acquireOrRenewLease(t.db, { holder: "d1" })).toBeNull();
    // A no-op: releasing with a (holder, epoch) pair that is no longer current must not free
    // d2's lease — that is the whole reason releaseLease is fenced instead of unconditional.
    await releaseLease(t.db, { holder: "d1", epoch: first.epoch });
    expect(await acquireOrRenewLease(t.db, { holder: "d3" })).toBeNull();
  });

  it("reports a stale lease so the dead-man alert has something to read", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 });
    const l = await readLease(t.db);
    expect(l).toMatchObject({ holder: "d1", stale: true });
    expect(l?.lastTickAt).toBeInstanceOf(Date);
  });

  it("reads back null before anyone has ever led — a cold cluster is not an error", async () => {
    expect(await readLease(t.db)).toBeNull();
  });

  it("releases cleanly on shutdown so the next dispatcher starts immediately", async () => {
    const l = held(await acquireOrRenewLease(t.db, { holder: "d1" }));
    await releaseLease(t.db, { holder: "d1", epoch: l.epoch });
    expect(await acquireOrRenewLease(t.db, { holder: "d2" })).toMatchObject({ holder: "d2" });
  });

  it("moves the deadline and the tick on renew, but never acquired_at — uptime must survive", async () => {
    const first = held(await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 5 }));
    const before = await leaseRow();
    const renewed = held(await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 600 }));
    const after = await leaseRow();

    // A renew that ignored ttlSeconds would leave the deadline where it was; +595s cannot be
    // mistaken for clock jitter the way a same-TTL comparison could.
    expect(renewed.expiresAt.getTime() - first.expiresAt.getTime()).toBeGreaterThan(500_000);
    expect(String(after?.["acquired_at"])).toBe(String(before?.["acquired_at"]));
    expect(String(after?.["last_tick_at"])).not.toBe(String(before?.["last_tick_at"]));
  });

  // Raw PGlite queries, not db.execute(): drizzle-orm 0.45 wraps the driver error, so its
  // `message` is only "Failed query: ..." and the SQLSTATE lives in `cause` (see tenancy.test.ts).
  it("keeps exactly one leadership row, forever", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1" });
    await expect(
      t.asDispatchRole(() =>
        t.raw.query(`INSERT INTO orc_dispatcher_lease (id, holder, expires_at)
                     VALUES (2, 'd2', now() + interval '10 seconds')`),
      ),
    ).rejects.toThrow(/orc_dispatcher_lease_singleton/);
    expect(await acquireOrRenewLease(t.db, { holder: "d2" })).toBeNull();
  });

  it("hides leadership from the request-path role — fleet infrastructure is not tenant data", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1" });
    // There is no RLS on this table to fall back on, so the GRANT is the whole defence: the
    // request path must be refused outright, not merely filtered down to zero rows.
    for (const stmt of [
      `SELECT * FROM orc_dispatcher_lease`,
      `UPDATE orc_dispatcher_lease SET holder = 'stolen'`,
    ]) {
      await expect(
        t.asTeam(a.teamId, () => t.raw.query(stmt)),
        stmt,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
