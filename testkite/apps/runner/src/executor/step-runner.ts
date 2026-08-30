/**
 * Walks a CasePlan's steps. The plan is already FROZEN by the compiler — every locator, every
 * argument and every loop row is baked in — so this file never looks anything up: no DB, no
 * element table, no authoring read. That is what makes a run reproducible.
 *
 * M3 executes `action` and `for`. `if` / `while` / `rest` need condition verbs and an HTTP verb
 * that are not ported until M4 (verb-kit currently registers web.click and web.enter, both still
 * TODO(M4)). Rather than silently skipping them — which would change what a test MEANS without
 * anyone noticing — an unsupported kind raises a NAMED fatal infra error.
 *
 * SCOPE — the step budget below bounds the WAIT, not the work. The 2026-08-29 spike measured a
 * lost `Promise.race` while the Playwright action it raced ran on to completion: nothing here
 * cancels anything. Cancellation is `run-chain.ts` closing the context in `finally`, and that
 * it truly cancels is only provable against real chromium (Task 12).
 */
import { FatalInfraError } from "@testkite/contract";
import type { CasePlan, StepPlan } from "@testkite/run-compiler";
import type { VerbDefinition } from "@testkite/verb-kit";
import type { EngineContextHandle } from "../browser/engine.js";
import { StepTimeoutError } from "./verdict.js";

export type VerbResolver = (opKey: string) => VerbDefinition | undefined;

export interface StepOutcome {
  readonly caseId: string;
  readonly ordinal: number;
  readonly status: "passed" | "failed";
  readonly durationMs: number;
  readonly message?: string;
  readonly screenshotSha256?: string;
}

export interface StepRunnerDeps {
  readonly handle: EngineContextHandle;
  readonly resolveVerb: VerbResolver;
  readonly stepTimeoutMs: number;
  readonly now: () => number;
  readonly onStep: (outcome: StepOutcome) => void;
  readonly screenshot: (handle: EngineContextHandle, outcome: StepOutcome) => Promise<string | null>;
  readonly log: (message: string) => void;
}

/** Thrown when a step legitimately fails — the chain stops here with verdict=failed. */
export class StepFailed extends Error {
  readonly outcome: StepOutcome;
  constructor(outcome: StepOutcome) {
    super(outcome.message ?? "step failed");
    this.name = "StepFailed";
    this.outcome = outcome;
  }
}

/**
 * Appends into the caller's `out` instead of returning a fresh array: a chain that stops on a
 * failed step still has to REPORT the steps that already ran. A returned array is lost the
 * moment `StepFailed` (or a timeout, or an infra throw) unwinds past the call, which would make
 * every non-passing chain look like it executed nothing.
 */
export async function runCase(kase: CasePlan, deps: StepRunnerDeps, out: StepOutcome[]): Promise<void> {
  await runSteps(kase.steps, kase.caseId, deps, out);
}

async function runSteps(
  steps: readonly StepPlan[],
  caseId: string,
  deps: StepRunnerDeps,
  out: StepOutcome[],
): Promise<void> {
  for (const step of steps) {
    if (step.kind === "action") {
      await runAction(step, caseId, deps, out);
      continue;
    }
    if (step.kind === "for") {
      // Loop rows were resolved at compile time; the body runs once per row, in order.
      const rows = step.loopRows ?? [];
      for (let i = 0; i < rows.length; i++) {
        deps.log(`for-loop iteration ${i + 1}/${rows.length} at ordinal ${step.ordinal}`);
        await runSteps(step.children, caseId, deps, out);
      }
      continue;
    }
    throw new FatalInfraError(
      `step kind "${step.kind}" at ordinal ${step.ordinal} is not executable yet — condition and REST verbs land in M4`,
    );
  }
}

async function runAction(
  step: Extract<StepPlan, { kind: "action" }>,
  caseId: string,
  deps: StepRunnerDeps,
  out: StepOutcome[],
): Promise<void> {
  const verb = deps.resolveVerb(step.opKey);
  if (verb === undefined) {
    throw new FatalInfraError(
      `opKey "${step.opKey}" is not in the verb registry — the plan was compiled against a different build`,
    );
  }

  const startedAt = deps.now();
  const running = verb.execute(deps.handle.opContext(deps.stepTimeoutMs, deps.log), step.args);

  // The step budget bounds the WAIT, not the work: Playwright keeps running after a lost race
  // (spike 2026-08-29), which is exactly why run-chain.ts closes the context in `finally`.
  const result = await Promise.race([
    running,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new StepTimeoutError(step.ordinal, deps.stepTimeoutMs)),
        deps.stepTimeoutMs,
      );
      timer.unref();
    }),
  ]);

  const base: StepOutcome = {
    caseId,
    ordinal: step.ordinal,
    status: result.ok ? "passed" : "failed",
    durationMs: deps.now() - startedAt,
    ...(result.ok ? {} : { message: result.failureMessage ?? "the op reported a failure without a message" }),
  };

  const sha = await deps.screenshot(deps.handle, base);
  const outcome: StepOutcome = sha === null ? base : { ...base, screenshotSha256: sha };
  out.push(outcome);
  deps.onStep(outcome);

  if (!result.ok) throw new StepFailed(outcome);
}
