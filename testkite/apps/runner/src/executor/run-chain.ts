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
import { assertNested, budgetForChain } from "./timeouts.js";
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
  // The plan's own stamped timeout wins; assertNested still guards the layers below it.
  assertNested({ ...budget, chainMs: Math.max(chainMs, budget.stepMs + 1) });

  const contextId = `${chain.chainKey}#${deps.now()}`;
  const steps: StepOutcome[] = [];

  let handle: EngineContextHandle | null = null;
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

    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new ChainTimeout(chainMs)), chainMs);
        timer.unref();
      }),
    ]);

    return { chainKey: chain.chainKey, verdict: "passed", steps };
  } catch (err) {
    if (err instanceof StepFailed) {
      return { chainKey: chain.chainKey, verdict: "failed", steps };
    }
    const cls = classifyError(err);
    if (cls.kind === "assertion") {
      return { chainKey: chain.chainKey, verdict: "failed", steps };
    }
    return {
      chainKey: chain.chainKey,
      verdict: "infra_error",
      steps,
      infra: { code: cls.code, retryable: cls.kind === "retryable-infra", message: cls.message },
    };
  } finally {
    // NOTHING may skip this — not a throw, not a timeout, not a cancellation.
    if (handle !== null) {
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
