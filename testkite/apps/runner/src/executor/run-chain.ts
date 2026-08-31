/**
 * One chain, one BrowserContext, closed in `finally` — NO exceptions (docs/SYSTEM_DESIGN.md §5).
 *
 * `finally` is load-bearing twice over. (1) Isolation: the context holds the chain's session, so
 * leaving it open would leak one tenant's login into the next chain. (2) Cancellation: the
 * 2026-08-29 spike showed a lost `Promise.race` does NOT cancel an in-flight Playwright action —
 * the only thing that truly stops it is closing the context. A chain that times out and leaves
 * its context open is exactly how the old system leaked browsers until the host died.
 *
 * SCOPE — this file is proven in CI only against `FakeBrowserEngine`, where `close()` flips a
 * boolean. So CI proves the ORCHESTRATION: one context per chain, close on every exit path,
 * every throw routed through `classifyError` into the right verdict. That closing a REAL context
 * actually cancels the action still running behind it is Task 12's claim, made against chromium.
 */
import { FatalInfraError } from "@testkite/contract";
import type { ChainPlan, RunPolicy } from "@testkite/run-compiler";
import type { BrowserEngine, EngineContextHandle } from "../browser/engine.js";
import { runCase, StepFailed, type StepOutcome, type VerbResolver } from "./step-runner.js";
import { assertNested, budgetForChain, raceDeadline } from "./timeouts.js";
import { classifyError } from "./verdict.js";

export interface ChainOutcome {
  readonly chainKey: string;
  readonly verdict: "passed" | "failed" | "infra_error";
  readonly steps: readonly StepOutcome[];
  readonly infra?: { readonly code: string; readonly retryable: boolean; readonly message: string };
}

export interface RunChainDeps {
  readonly engine: BrowserEngine;
  readonly resolveVerb: VerbResolver;
  readonly now: () => number;
  readonly onStep: (outcome: StepOutcome) => void;
  readonly screenshot: (handle: EngineContextHandle, outcome: StepOutcome) => Promise<string | null>;
  /**
   * Retain-on-failure for the trace (§5.1). Called with the settled verdict while the context is
   * STILL OPEN, because `context.tracing.stop()` needs a live context — after `close()` the trace
   * is gone, which is why this cannot be left to the caller: only this function knows both the
   * verdict and the last moment the handle is usable. Optional: a caller that does not collect
   * traces simply never keeps one, and the context close below discards it.
   */
  readonly finishTrace?: (handle: EngineContextHandle, verdict: ChainOutcome["verdict"]) => Promise<void>;
  readonly log: (message: string) => void;
}

class ChainTimeout extends Error {
  constructor(ms: number) {
    super(`chain exceeded its ${ms}ms budget`);
    this.name = "TimeoutError"; // classified as an assertion: a hanging app is a product signal
  }
}

export async function runChain(chain: ChainPlan, policy: RunPolicy, deps: RunChainDeps): Promise<ChainOutcome> {
  const budget = budgetForChain(chain.stepCount);
  const chainMs = chain.timeoutSeconds * 1000;
  // The plan's own stamped timeout wins, and the guard runs on THAT value — the one handed to the
  // engine below and to `raceDeadline`. Clamping it here (`Math.max(chainMs, stepMs + 1)`) made
  // the guard a no-op for the single shape it exists to catch: a plan whose chain budget is
  // shorter than the step budget nested inside it. That plan is a compiler/runner disagreement
  // about the timeout ladder, and it must fail before a browser is opened, not silently un-bound
  // a layer. The compiler's floor is 180s, so no plan this runner is meant to execute trips it.
  assertNested({ ...budget, chainMs });

  const contextId = `${chain.chainKey}#${deps.now()}`;
  const steps: StepOutcome[] = [];

  let handle: EngineContextHandle | null = null;
  // Read by `finally` to decide whether the trace is kept. Starts pessimistic: if control leaves
  // this function by a path nobody anticipated, the evidence is retained rather than dropped.
  let verdict: ChainOutcome["verdict"] = "infra_error";
  try {
    const context = await deps.engine.newChainContext({
      contextId,
      baseUrl: policy.baseUrl,
      timeouts: { ...budget, chainMs },
      trace: true, // always start; retain-on-failure decides whether to KEEP it
    });
    handle = context;

    const work = (async () => {
      for (const kase of chain.cases) {
        // `steps` is handed IN, not collected from a return value: a step that fails or times
        // out unwinds this loop, and the outcomes gathered up to that point must still be part
        // of the chain outcome.
        await runCase(
          kase,
          {
            handle: context,
            resolveVerb: deps.resolveVerb,
            stepTimeoutMs: budget.stepMs,
            now: deps.now,
            onStep: deps.onStep,
            screenshot: deps.screenshot,
            log: deps.log,
          },
          steps,
        );
      }
    })();

    // `raceDeadline` clears the deadline timer on every exit path. A timer left pending holds
    // this frame — and through `deps`, the ClaimedJob and the whole frozen plan — alive for the
    // rest of the chain budget, which is how the 200-chain soak first measured node's RSS floor
    // climbing ~0.5MB per chain (2026-08-31).
    await raceDeadline(work, chainMs, () => new ChainTimeout(chainMs));

    verdict = "passed";
    return { chainKey: chain.chainKey, verdict, steps };
  } catch (err) {
    if (err instanceof StepFailed) {
      verdict = "failed";
      return { chainKey: chain.chainKey, verdict, steps };
    }
    const cls = classifyError(err);
    if (cls.kind === "assertion") {
      verdict = "failed";
      return { chainKey: chain.chainKey, verdict, steps };
    }
    verdict = "infra_error";
    return {
      chainKey: chain.chainKey,
      verdict,
      steps,
      infra: { code: cls.code, retryable: cls.kind === "retryable-infra", message: cls.message },
    };
  } finally {
    // NOTHING may skip this — not a throw, not a timeout, not a cancellation.
    if (handle !== null) {
      // The trace first: stopping it needs the context alive, and a trace that fails to land is
      // lost evidence, never a lost verdict — so it is logged and the close still happens.
      try {
        await deps.finishTrace?.(handle, verdict);
      } catch (traceErr) {
        deps.log(`context ${contextId} failed to finish its trace: ${String(traceErr)}`);
      }
      try {
        await handle.close();
      } catch (closeErr) {
        deps.log(`context ${contextId} failed to close: ${String(closeErr)}`);
      }
    }
  }
}

/** Re-exported so callers do not need to know which file inside executor/ defines it. */
export { FatalInfraError };
export type { StepOutcome, VerbResolver };
