/**
 * The dispatcher is a LOOP AROUND ONE PURE-ISH FUNCTION. `runDispatcherTick` does one round
 * and returns what happened; `startDispatcher` is the thin timer around it. Tests call the
 * tick directly — a test that waits on setInterval measures the clock, not the code.
 *
 * v1 is strictly FIFO (blueprint §5: "fallback FIFO"). Deficit-weighted round robin, per-team
 * caps and the 60s starvation floor are M5; `job_runs.cost` already carries the number DRR
 * will need, so M5 changes the ORDER BY, not the schema.
 *
 * Correctness does not depend on there being exactly one leader: dispatchPending uses
 * FOR UPDATE SKIP LOCKED and a conditional UPDATE, so two dispatchers in a split-brain window
 * split the work instead of duplicating it (proved on real Postgres in
 * test/concurrency/job-claim-race.test.ts). Leadership exists to keep the REAPER
 * single-threaded — two sweeps requeueing the same team both compute MIN(queue_seq) - 1 and
 * tie (spike §4) — and to keep the tick rate predictable.
 *
 * DELIBERATE DEVIATION from the plan's block: the plan renews every LEASE_RENEW_EVERY_TICKS-th
 * tick and does not look at the lease AT ALL in between, which leaves two holes its own tests
 * point at. (1) A takeover would go unnoticed for up to 2.5s of dispatching and reaping.
 * (2) Worse, a process that stalled past its own TTL — the one way leadership is really lost —
 * would wake up and reap alongside its successor. So a tick that is not renewing still
 * CONFIRMS ownership, with one cheap `SELECT` against the database clock. The write cadence
 * (and the TTL headroom that comes with it) is exactly what the spike settled on.
 */
import { reapDeadLeases } from "../queue/reaper.js";
import { dispatchPending } from "../queue/job-queue.js";
import {
  acquireOrRenewLease,
  readLease,
  releaseLease,
  LEASE_RENEW_EVERY_TICKS,
  type DispatcherLease,
} from "./lease.js";
import type { TkDb } from "../../kernel/index.js";

export const TICK_MS = 250;
export const FANOUT_PER_TICK = 200;

export interface TickResult {
  readonly leader: boolean;
  readonly dispatched: number;
  readonly reaped: { readonly suspect: number; readonly requeued: number; readonly failed: number };
}

export interface DispatcherHooks {
  readonly onTick?: (r: TickResult) => void;
  readonly onLeadershipLost?: (holder: string) => void;
  readonly onDeadMan?: (lease: { readonly holder: string; readonly lastTickAt: Date | null }) => void;
}

export interface DispatcherState {
  holder: string;
  ticks: number;
  lease: DispatcherLease | null;
}

const IDLE: TickResult["reaped"] = { suspect: 0, requeued: 0, failed: 0 };

/**
 * Answers "may this tick touch the queue?" and keeps `state.lease` in step with the answer.
 *
 * Two paths, one meaning. On the renew tick (and on the first tick of a follower) it WRITES:
 * `acquireOrRenewLease` renews, takes over an expired lease, or returns null. In between it
 * READS: holder and epoch must still be ours and the deadline must not have passed. Losing
 * the lease is not an error — it is the normal state of every dispatcher that is not leading —
 * so it is reported through `onLeadershipLost` exactly once, on the transition, and never
 * thrown.
 */
async function holdsLeadership(
  db: TkDb,
  state: DispatcherState,
  hooks?: DispatcherHooks,
): Promise<boolean> {
  const held = state.lease;

  if (held !== null && state.ticks % LEASE_RENEW_EVERY_TICKS !== 0) {
    const current = await readLease(db);
    const mine =
      current !== null &&
      current.holder === state.holder &&
      current.epoch === held.epoch &&
      !current.stale;
    if (mine) return true;
    // Either somebody took over, or our own deadline lapsed while this process was stalled.
    // Both mean the same thing: stop working NOW and re-enter the election next tick.
    state.lease = null;
    hooks?.onLeadershipLost?.(state.holder);
    return false;
  }

  // Read BEFORE the election, and only when we are not already the leader: the dead-man
  // condition is a property of the lease we are about to replace, which the takeover erases.
  const before = held === null ? await readLease(db) : null;
  const lease = await acquireOrRenewLease(db, { holder: state.holder });
  if (lease === null) {
    if (held !== null) hooks?.onLeadershipLost?.(state.holder);
    state.lease = null;
    return false;
  }
  // A stale lease held by SOMEBODY ELSE means that dispatcher died without releasing: the
  // queue was unattended until this moment. That is the dead-man condition — and a cold
  // cluster (`before === null`) is not it.
  if (before !== null && before.stale && before.holder !== state.holder) {
    hooks?.onDeadMan?.({ holder: before.holder, lastTickAt: before.lastTickAt });
  }
  state.lease = lease;
  return true;
}

export async function runDispatcherTick(
  db: TkDb,
  state: DispatcherState,
  hooks?: DispatcherHooks,
  fanout: number = FANOUT_PER_TICK,
): Promise<TickResult> {
  state.ticks += 1;

  if (!(await holdsLeadership(db, state, hooks))) {
    const followed: TickResult = { leader: false, dispatched: 0, reaped: IDLE };
    hooks?.onTick?.(followed);
    return followed;
  }

  // Reap FIRST: a chain the sweep puts back at the head of its team's queue then leaves again
  // in this very tick, instead of waiting 250ms for the next one.
  const reaped = await reapDeadLeases(db);
  const dispatched = await dispatchPending(db, { limit: fanout });
  const result: TickResult = { leader: true, dispatched, reaped };
  hooks?.onTick?.(result);
  return result;
}

export function startDispatcher(
  db: TkDb,
  opts: { readonly holder: string; readonly hooks?: DispatcherHooks },
): { readonly stop: () => Promise<void> } {
  const state: DispatcherState = { holder: opts.holder, ticks: 0, lease: null };
  let inFlight: Promise<void> = Promise.resolve();
  let running = false;
  let stopped = false;

  // setInterval, NOT a self-scheduling await chain: a tick that runs long must be SKIPPED,
  // not queued behind the previous one — a backlog of ticks would keep dispatching after a
  // stall, all at once, right when the DB is already slow.
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    inFlight = runDispatcherTick(db, state, opts.hooks)
      .then(() => undefined)
      .catch(() => undefined) // a failed tick is a metric, never a crashed process
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Waiting for the tick in flight is part of the handover: releasing the lease while our
      // own reaper is still writing invites the successor to sweep the same teams we are.
      await inFlight;
      if (state.lease !== null) await releaseLease(db, { holder: state.holder, epoch: state.lease.epoch });
    },
  };
}
