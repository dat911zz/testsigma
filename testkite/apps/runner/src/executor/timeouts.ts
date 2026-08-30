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
