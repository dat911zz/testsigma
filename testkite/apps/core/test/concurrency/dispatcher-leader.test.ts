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
 *     minutes-to-hours of no dispatcher behind a network partition;
 *  4. an identity that is not unique per live process (the hostname alone, say) ⇒ every
 *     candidate matches the "holder = me" branch, which is a RENEW, so all of them lead at
 *     once, permanently, with an epoch that never advances.
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
import { defaultDispatcherId } from "../../src/modules/kernel/env.js";
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
  /**
   * A SECOND pool, with its own physical connections — the closest a test gets to a second OS
   * process. Two calls on one pool would still be two connections, but a separate pool also
   * separates the pg client state, which is precisely what the advisory-lock trap turned on.
   */
  let other: RealDb;

  beforeAll(async () => {
    r = await makeRealDb();
    other = await makeRealDb();
    await warmPool(r.pool, PARALLEL);
    await warmPool(other.pool, 2);
  });
  afterAll(async () => {
    await r.close();
    await other.close();
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

  it("elects one leader out of two dispatcher processes on the SAME host (default identity)", async () => {
    // Same hostname, two live processes — node cluster, `pm2 -i`, a rolling deploy that
    // overlaps old and new, two containers sharing the host UTS namespace. The default
    // identity must separate them without an operator having to know it should.
    const a = defaultDispatcherId("runner-a", 4242);
    const b = defaultDispatcherId("runner-a", 4243);
    expect(a).not.toBe(b);
    for (let round = 0; round < 3; round += 1) {
      const raced = await Promise.all([
        acquireOrRenewLease(r.db, { holder: a }),
        acquireOrRenewLease(other.db, { holder: b }),
      ]);
      // Not just on the first round: the loser must keep losing while the winner renews,
      // which is what makes the reaper single-writer for longer than one tick.
      expect(raced.filter((x): x is DispatcherLease => x !== null), `round ${String(round)}`).toHaveLength(1);
    }
    expect(await readLease(r.db)).toMatchObject({ epoch: 1, stale: false });
  });

  it("would run TWO leaders indefinitely if both processes shared one identity — why the default carries the pid", async () => {
    // Characterisation of the hazard the default exists to avoid, run on the same two-pool
    // setup as the test above. `hostname()` alone was the original T8 default; here it stands
    // for any two processes that end up with one holder string.
    const collided = "runner-a";
    for (let round = 0; round < 3; round += 1) {
      const both = await Promise.all([
        acquireOrRenewLease(r.db, { holder: collided }),
        acquireOrRenewLease(other.db, { holder: collided }),
      ]);
      // BOTH win, every round: the same-holder branch of the election is defined as a renew,
      // so neither connection ever loses. This is a sustained state, not the brief takeover
      // window the loop's comments describe.
      expect(both.every((x) => x !== null), `round ${String(round)}`).toBe(true);
    }
    // And the epoch never advances, so job_runs' epoch fencing cannot tell the two apart
    // either: two reapers sweep the same team, and the single-writer invariant the whole
    // lease exists to provide is gone. Hence: identities must be unique per LIVE PROCESS.
    expect(await readLease(r.db)).toMatchObject({ holder: collided, epoch: 1 });
  });
});
