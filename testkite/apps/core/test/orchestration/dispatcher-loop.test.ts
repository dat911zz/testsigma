/**
 * The dispatcher tick — one round of the loop, on PGlite.
 *
 * What this layer proves is the DECISION of a tick: whether it may work at all (does it hold
 * the lease?), how much it hands out (fan-out cap), in which order (FIFO, no fair share until
 * M5), that reaping and dispatching happen in the SAME round, and which alerts fire on the
 * leadership transitions. Whether two dispatchers racing on the same queue can hand one job
 * out twice is a question about locks, and PGlite's single wasm connection cannot answer it —
 * that half is already proved on real Postgres in test/concurrency/job-claim-race.test.ts
 * ("dispatches each pending job exactly once even with two dispatchers racing") and
 * test/concurrency/dispatcher-leader.test.ts (one leader out of five candidates).
 *
 * Deliberate deviations from the plan's block:
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as reaper.test.ts / dispatcher-lease.test.ts).
 *  - the plan's leadership-loss test ticks TWICE, but the plan's own implementation only looks
 *    at the lease every LEASE_RENEW_EVERY_TICKS-th tick, so tick 2 would have dispatched with
 *    a lease somebody else already owns. The tick therefore CONFIRMS ownership with a cheap
 *    read on the ticks it does not renew (see loop.ts), and this suite pins both halves: the
 *    read-only tick ("only READS the lease between renewals") and the write on the renew tick.
 *  - four tests the plan's six leave out: the read/renew split above, recovery after a loss,
 *    the onTick hook, and `startDispatcher` itself (timer really stops, lease really released).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { firstRow, rowsOf } from "../../src/modules/kernel/index.js";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  FANOUT_PER_TICK,
  TICK_MS,
  runDispatcherTick,
  startDispatcher,
  type DispatcherState,
  type TickResult,
} from "../../src/modules/orchestration/dispatcher/loop.js";
import {
  acquireOrRenewLease,
  LEASE_RENEW_EVERY_TICKS,
} from "../../src/modules/orchestration/dispatcher/lease.js";

const state = (holder: string): DispatcherState => ({ holder, ticks: 0, lease: null });

const NOTHING_REAPED: TickResult["reaped"] = { suspect: 0, requeued: 0, failed: 0 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `done` instead of sleeping a fixed amount: a timing test must not encode a guess. */
async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await sleep(10);
  }
}

describe("dispatcher loop", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
  });

  /** `runDispatcherTick` with a tighter fan-out, so an ordering test needs 3 jobs, not 600. */
  const tickWithLimit = (st: DispatcherState, limit: number): Promise<TickResult> =>
    runDispatcherTick(t.db, st, undefined, limit);

  const countByStatus = async (status: string): Promise<number> => {
    const row = firstRow(
      await t.db.execute(sql`SELECT count(*)::int AS n FROM job_runs WHERE status::text = ${status}`),
    );
    return Number(row?.["n"] ?? -1);
  };

  const chainKeys = async (status: string): Promise<readonly string[]> =>
    rowsOf(
      await t.db.execute(sql`SELECT chain_key FROM job_runs
                              WHERE status::text = ${status} ORDER BY queue_seq, id`),
    ).map((row) => String(row["chain_key"]));

  /**
   * The lease row as TEXT: timestamptz carries microseconds, and `new Date()` would round two
   * stamps 300µs apart into the same millisecond — exactly the difference "did this tick write
   * to the lease?" turns on.
   */
  const leaseStamps = async (): Promise<Record<string, string>> => {
    const row = firstRow(
      await t.db.execute(sql`SELECT holder, epoch::text AS epoch, expires_at::text AS expires_at,
                                    last_tick_at::text AS last_tick_at FROM orc_dispatcher_lease`),
    );
    if (row === undefined) throw new Error("no orc_dispatcher_lease row");
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]));
  };

  it("dispatches nothing at all when it is not the leader", async () => {
    await acquireOrRenewLease(t.db, { holder: "other" });
    await t.seedJobs(a, 5);

    const r = await runDispatcherTick(t.db, state("me"));

    expect(r).toMatchObject({ leader: false, dispatched: 0 });
    expect(await countByStatus("pending")).toBe(5);
  });

  it("caps fan-out at 200 jobs per tick", async () => {
    await t.seedJobs(a, FANOUT_PER_TICK + 50);

    expect((await runDispatcherTick(t.db, state("me"))).dispatched).toBe(FANOUT_PER_TICK);
    // The remainder goes out on the next tick, 250ms later — a backlog is drained, not dropped.
    expect((await runDispatcherTick(t.db, state("me"))).dispatched).toBe(50);
    expect(await countByStatus("pending")).toBe(0);
  });

  it("dispatches in FIFO order across teams — v1 has no fair share, that is M5", async () => {
    await t.seedJobs(a, 2, ["a1", "a2"]);
    await t.seedJobs(b, 2, ["b1", "b2"]);
    const st = state("me");

    for (let i = 0; i < 3; i += 1) expect((await tickWithLimit(st, 1)).dispatched).toBe(1);

    // Team A queued first, so team A goes first — all of it. Deficit-weighted round robin
    // would have interleaved the two teams; M5 changes this ORDER BY, not the schema.
    expect(await chainKeys("dispatched")).toEqual(["a1", "a2", "b1"]);
  });

  it("reaps dead leases in the same tick that it dispatches", async () => {
    await t.seedJobs(a, 1);
    await t.markRunningWithDeadHeartbeat(a.teamId);

    const r = await runDispatcherTick(t.db, state("me"));

    expect(r.reaped).toEqual({ suspect: 1, requeued: 1, failed: 0 });
    // Reaping runs BEFORE the fan-out on purpose: the chain the reaper just put back at the
    // head of its team's queue leaves again in this very tick instead of waiting for the next.
    expect(r.dispatched).toBe(1);
  });

  it("fires the dead-man hook when the lease it takes over was stale and held by someone else", async () => {
    await acquireOrRenewLease(t.db, { holder: "ghost", ttlSeconds: 0 });
    const onDeadMan = vi.fn();
    const st = state("me");

    expect((await runDispatcherTick(t.db, st, { onDeadMan })).leader).toBe(true);

    // The queue was unattended until this moment: that gap is what the alert is about.
    expect(onDeadMan).toHaveBeenCalledWith(expect.objectContaining({ holder: "ghost" }));
    // "me" takes over IN THIS TICK, so the alert fires exactly once, on the transition.
    await runDispatcherTick(t.db, st, { onDeadMan });
    expect(onDeadMan).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on the dead-man hook when nobody had ever led", async () => {
    const onDeadMan = vi.fn();

    expect((await runDispatcherTick(t.db, state("me"), { onDeadMan })).leader).toBe(true);

    // A cold cluster is not a dead dispatcher, and must not page anyone.
    expect(onDeadMan).not.toHaveBeenCalled();
  });

  it("reports leadership loss instead of silently dispatching with a dead lease", async () => {
    const st = state("me");
    await runDispatcherTick(t.db, st); // "me" wins the election
    await t.expireLease();
    await acquireOrRenewLease(t.db, { holder: "rival" });
    await t.seedJobs(a, 3);
    const onLeadershipLost = vi.fn();

    const r = await runDispatcherTick(t.db, st, { onLeadershipLost });

    expect(r).toMatchObject({ leader: false, dispatched: 0 });
    expect(onLeadershipLost).toHaveBeenCalledWith("me");
    // Not one row touched: a dispatcher that lost the lease must stop REAPING too — two
    // reapers requeueing the same team both land on MIN(queue_seq) - 1 (spike §4).
    expect(await countByStatus("pending")).toBe(3);
    // Exactly once, on the transition: from here on this process is a plain follower.
    await runDispatcherTick(t.db, st, { onLeadershipLost });
    expect(onLeadershipLost).toHaveBeenCalledTimes(1);
  });

  it("takes the lease back on a later tick once the rival's lease lapses", async () => {
    const st = state("me");
    await runDispatcherTick(t.db, st);
    await t.expireLease();
    await acquireOrRenewLease(t.db, { holder: "rival", ttlSeconds: 0 });
    expect((await runDispatcherTick(t.db, st)).leader).toBe(false);

    const onDeadMan = vi.fn();
    const r = await runDispatcherTick(t.db, st, { onDeadMan });

    // Losing the lease is not a terminal state: the follower keeps probing every tick and
    // takes over as soon as the rival stops renewing.
    expect(r.leader).toBe(true);
    expect(onDeadMan).toHaveBeenCalledWith(expect.objectContaining({ holder: "rival" }));
  });

  it("only READS the lease between renewals, and renews on the renew tick", async () => {
    const st = state("me");
    await runDispatcherTick(t.db, st); // tick 1: the election, a write
    const elected = await leaseStamps();

    await runDispatcherTick(t.db, st); // tick 2: confirms ownership, writes nothing
    expect(await leaseStamps()).toEqual(elected);
    while (st.ticks < LEASE_RENEW_EVERY_TICKS) {
      expect((await runDispatcherTick(t.db, st)).leader).toBe(true);
    }
    const renewed = await leaseStamps();

    // Renewing every 10th tick = every 2.5s against a 10s TTL: three chances to renew before
    // the lease lapses, so an ordinary GC pause never costs us leadership (spike §3).
    expect(renewed["expires_at"]).not.toBe(elected["expires_at"]);
    // A renew is not a takeover — an epoch that churned would fence this dispatcher's own
    // in-flight writes on every renewal.
    expect(renewed["epoch"]).toBe(elected["epoch"]);
    expect(renewed["holder"]).toBe("me");
  });

  it("reports every tick through onTick, leader or not", async () => {
    const onTick = vi.fn();
    await t.seedJobs(a, 2);

    const led = await runDispatcherTick(t.db, state("me"), { onTick });
    await t.expireLease();
    await acquireOrRenewLease(t.db, { holder: "rival" });
    const followed = await runDispatcherTick(t.db, state("me"), { onTick });

    expect(led).toEqual({ leader: true, dispatched: 2, reaped: NOTHING_REAPED });
    expect(followed).toEqual({ leader: false, dispatched: 0, reaped: NOTHING_REAPED });
    // A follower tick is a tick: the metric must not go silent just because we lost, or a
    // stalled follower would look exactly like a healthy one.
    expect(onTick.mock.calls).toEqual([[led], [followed]]);
  });

  it("keeps ticking on a timer and hands the lease back when it stops", async () => {
    await t.seedJobs(a, 1);
    const ticks: TickResult[] = [];
    const dispatcher = startDispatcher(t.db, {
      holder: "me",
      hooks: {
        onTick: (r) => {
          ticks.push(r);
        },
      },
    });
    try {
      await waitUntil(() => ticks.length >= 2, 10_000);
    } finally {
      await dispatcher.stop();
    }
    const seen = ticks.length;
    await sleep(TICK_MS * 3);

    expect(ticks[0]).toMatchObject({ leader: true, dispatched: 1 });
    expect(ticks.length, "clearInterval must really stop the loop").toBe(seen);
    // A clean shutdown expires the lease instead of making the next dispatcher wait out the
    // full TTL — 10s of nobody dispatching, every deploy.
    expect(await acquireOrRenewLease(t.db, { holder: "next" })).toMatchObject({ holder: "next" });
  });
});
