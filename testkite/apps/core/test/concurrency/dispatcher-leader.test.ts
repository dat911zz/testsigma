/**
 * Two dispatchers, one leader — on REAL Postgres, over real connections.
 *
 * WHY IT CANNOT LIVE ON PGlite: every question here is "what happens when N candidates hit
 * the SAME row at the SAME instant". PGlite has one wasm connection, so its "simultaneous"
 * elections merely queue up and a broken election would still elect one winner — a FALSE
 * GREEN (see test/harness/realpg.ts). The state machine half — renew vs takeover, fencing,
 * the dead-man's `stale` flag — is proved in test/orchestration/dispatcher-lease.test.ts;
 * what is proved HERE is that contention cannot produce two leaders, and that failover
 * really tracks the TTL instead of hanging on a dead session.
 *
 * Three regressions this file exists to catch:
 *  1. electing by SELECT-then-UPDATE ⇒ two candidates both read "expired" and both write ⇒
 *     two leaders, silently (the same read-then-lock trap that was fixed in the relay outbox);
 *  2. going back to `pg_advisory_lock` ⇒ measured 2026-08-29: pg.Pool hands the SAME session
 *     back after release() and the second try_advisory_lock SUCCEEDS, so a returned
 *     connection quietly creates a co-leader;
 *  3. a failover that waits for the dead leader's SESSION to die rather than for its TTL ⇒
 *     minutes-to-hours of no dispatcher behind a network partition.
 *
 * `warmPool` precedes every race: on a cold pool `Promise.all` is not parallel at all — the
 * second caller must open a physical connection (TCP + auth) and only reaches the table after
 * the first has COMMITted, the false green documented in promote-lock.test.ts.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  acquireOrRenewLease,
  readLease,
  type DispatcherLease,
} from "../../src/modules/orchestration/dispatcher/lease.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;

/** Opens `n` physical connections BEFORE the race, so `Promise.all` is parallel from the first ms. */
async function warmPool(pool: RealDb["pool"], n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

describeRealPg("dispatcher leadership on a real Postgres", () => {
  let r: RealDb;

  beforeAll(async () => {
    r = await makeRealDb();
    await warmPool(r.pool, PARALLEL);
  });
  afterAll(async () => {
    await r.close();
  });
  beforeEach(async () => {
    await r.db.execute(sql`TRUNCATE orc_dispatcher_lease`);
  });

  it("elects exactly one leader out of 5 simultaneous candidates", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => acquireOrRenewLease(r.db, { holder: `d${String(i)}` })),
    );
    const winners = results.filter((x): x is DispatcherLease => x !== null);
    expect(winners).toHaveLength(1);
    // Nobody "won" a row that the table then disagrees with, and the very first election is
    // an INSERT, so the epoch must still be 1: a 2 here would mean two writes went through.
    expect(await readLease(r.db)).toMatchObject({ holder: winners[0]?.holder, epoch: 1 });
  });

  it("keeps exactly one leader when a renew and a takeover race on an EXPIRED lease", async () => {
    await acquireOrRenewLease(r.db, { holder: "d1", ttlSeconds: 0 });
    // Both candidates match the election predicate at the same instant: d1 because it is the
    // holder, d2 because the deadline has passed. Whoever gets the row lock first commits;
    // the loser must re-read the row it was blocked on and find the predicate no longer true.
    // A SELECT-then-UPDATE implementation lets BOTH through — that is regression #1.
    const raced = await Promise.all([
      acquireOrRenewLease(r.db, { holder: "d1" }),
      acquireOrRenewLease(r.db, { holder: "d2" }),
    ]);
    const winners = raced.filter((x): x is DispatcherLease => x !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error("no candidate won the race");
    // A renew keeps epoch 1, a takeover moves it to 2 — either is correct, but the table and
    // the winner's own answer must tell the SAME story, and the epoch must never go backwards.
    expect(await readLease(r.db)).toMatchObject({ holder: winner.holder, epoch: winner.epoch });
    expect(winner.epoch).toBe(winner.holder === "d1" ? 1 : 2);
  });

  it("does not hand leadership over when a pooled connection is returned — the pg_advisory_lock trap", async () => {
    const first = await acquireOrRenewLease(r.db, { holder: "d1" });
    expect(first).toMatchObject({ holder: "d1", epoch: 1 });
    // Every call below runs on a connection cycled back through the SAME pool — the exact
    // setup in which pg_try_advisory_lock was measured to succeed a second time because the
    // pool returns the session that still holds the lock. Leadership lives in a row, so the
    // session it was acquired on is not part of the answer.
    for (let i = 0; i < PARALLEL; i += 1) {
      expect(await acquireOrRenewLease(r.db, { holder: `challenger-${String(i)}` })).toBeNull();
    }
    expect(await readLease(r.db)).toMatchObject({ holder: "d1", epoch: 1, stale: false });
  });

  it("promotes a challenger within ~TTL after the leader stops renewing", async () => {
    await acquireOrRenewLease(r.db, { holder: "d1", ttlSeconds: 1 });
    const started = Date.now();
    let won: DispatcherLease | null = null;
    while (won === null && Date.now() - started < 5_000) {
      won = await acquireOrRenewLease(r.db, { holder: "d2", ttlSeconds: 1 });
      if (won === null) await new Promise((res) => setTimeout(res, 250));
    }
    const elapsed = Date.now() - started;
    expect(won).toMatchObject({ holder: "d2", epoch: 2 });
    // TTL 1s + a 250ms poll: comfortably under 2s. The production TTL of 10s measured ~5.03s
    // at TTL=5s in the 2026-08-29 spike, i.e. failover tracks the TTL linearly — and, unlike
    // an advisory lock, it does so no matter HOW the old leader died.
    expect(elapsed).toBeLessThan(2_000);
    // The dead-man saw the gap while it lasted: the promotion is a new epoch, not a renew.
    expect(await readLease(r.db)).toMatchObject({ holder: "d2", stale: false });
  });
});
