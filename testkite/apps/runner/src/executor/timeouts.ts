/**
 * Nested timeouts (docs/SYSTEM_DESIGN.md §5): action 15s < navigation 30s < step 60s <
 * chain clamp(90 + 12×steps, 180..900)s. Nesting is what stops a hung page from holding a
 * browser slot all night — every layer is bounded by the one above it.
 *
 * The chain formula is NOT reimplemented here: it is imported from the compiler, which already
 * stamps `timeoutSeconds` into every ChainPlan. Two copies of one formula is two chances to
 * disagree about how long a chain may live.
 *
 * SCOPE — what a budget can and cannot do. These numbers bound how long the executor WAITS;
 * they do not cancel anything. The spike (plan §10) measured a `Promise.race` fire at 501ms
 * while the Playwright action it raced kept running to completion: only `context.close()`
 * actually cancels. So a budget is only half the mechanism — `run-chain.ts` (Task 11) closing
 * the context in `finally`, without exception, is the other half. This module is pure
 * arithmetic over frozen constants and is fully proven in CI; the cancellation half is only
 * provable against a real browser (Task 12).
 */
import { chainTimeoutSeconds } from "@testkite/run-compiler";
import { MEMORY } from "../memory-governance.js";

export interface TimeoutBudget {
  readonly actionMs: number;
  readonly navigationMs: number;
  readonly stepMs: number;
  readonly chainMs: number;
}

export function budgetForChain(stepCount: number): TimeoutBudget {
  return {
    actionMs: MEMORY.timeoutsSec.action * 1000,
    navigationMs: MEMORY.timeoutsSec.nav * 1000,
    stepMs: MEMORY.timeoutsSec.step * 1000,
    chainMs: chainTimeoutSeconds(stepCount) * 1000,
  };
}

/**
 * Races `work` against a deadline and ALWAYS clears the loser's timer.
 *
 * The clearing is the point of this function, and it is not tidiness. A pending `setTimeout`
 * holds its callback closure alive, and that closure reaches — through the reject function, the
 * raced promise and the frames awaiting it — the executor's deps, the worker's `onStep` closure,
 * the ClaimedJob and finally the whole frozen RunPlan. The 200-chain acceptance soak measured
 * exactly that on 2026-08-31: nine uncleared timers per chain (eight steps plus the chain) held
 * ONE FULLY PARSED RunPlan per chain — ~0.5MB of node RSS each — until every timer eventually
 * fired, up to 180s later. A burst of short chains therefore grew the RSS floor without limit
 * for three minutes at a time: the slow death of §1, rebuilt by an unfired timer.
 *
 * `unref()` is not a substitute and never was: it stops a timer from holding the event loop
 * OPEN, not from holding memory. It stays on so a worker shutting down mid-chain is not pinned
 * by a deadline that has not expired yet.
 *
 * This bounds the WAIT, never the WORK — a lost race does not cancel a Playwright action
 * (spike 2026-08-29); closing the context does, which is `run-chain.ts`'s `finally`.
 */
export async function raceDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fails loudly if a future edit breaks the nesting — a budget that is not nested silently un-bounds a layer. */
export function assertNested(b: TimeoutBudget): void {
  if (!(b.actionMs < b.navigationMs)) {
    throw new Error(`timeout nesting broken: action ${b.actionMs}ms >= navigation ${b.navigationMs}ms`);
  }
  if (!(b.navigationMs < b.stepMs)) {
    throw new Error(`timeout nesting broken: navigation ${b.navigationMs}ms >= step ${b.stepMs}ms`);
  }
  if (!(b.stepMs < b.chainMs)) {
    throw new Error(`timeout nesting broken: step ${b.stepMs}ms >= chain ${b.chainMs}ms`);
  }
}
