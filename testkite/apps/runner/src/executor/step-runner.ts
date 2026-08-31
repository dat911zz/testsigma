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
 * DATA BINDING — inside a `for` body the compiler deliberately leaves `$data:<column>` args
 * UNRESOLVED (packages/run-compiler/src/phase45-resolve.ts: "the data column belongs to the loop
 * row, which only the worker knows — the compiler has nothing to substitute yet"). Finishing that
 * substitution, once per iteration, is this file's half of the contract: see `bindLoopArgs`.
 *
 * SCOPE — the step budget below bounds the WAIT, not the work. The 2026-08-29 spike measured a
 * lost `Promise.race` while the Playwright action it raced ran on to completion: nothing here
 * cancels anything. Cancellation is `run-chain.ts` closing the context in `finally`, and that
 * it truly cancels is only provable against real chromium (Task 12).
 */
import { FatalInfraError } from "@testkite/contract";
import type { CasePlan, DataRow, StepPlan } from "@testkite/run-compiler";
import type { VerbDefinition } from "@testkite/verb-kit";
import type { EngineContextHandle } from "../browser/engine.js";
import { raceDeadline } from "./timeouts.js";
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
  await runSteps(kase.steps, kase.caseId, deps, out, NO_LOOP_ROW);
}

/**
 * Outside a `for` body there is nothing left for the worker to bind: compiler phase 5 already
 * merged the case's own data row into those args.
 */
const NO_LOOP_ROW: Readonly<Record<string, string>> = Object.freeze({});

/** Whole-string `$data:<column>` ref — the same shape compiler phase 5 parses, data family only. */
const DATA_REF = /^\$data:(.+)$/;

/**
 * Substitutes `$data:<column>` args against the row the enclosing `for` is currently on.
 *
 * Without this a `for` over three rows would call the verb three times with the literal string
 * "$data:user" — the loop would repeat, but it would not be data-driven at all.
 *
 * The rules mirror the compiler's `mergeArgs` deliberately, so a ref means the same thing
 * whichever side of the plan boundary resolves it:
 *  - substitute only when the WHOLE arg is a ref, never inside a longer string;
 *  - EXACTLY ONE PASS — a substituted value is never re-scanned, so a data row cannot smuggle
 *    itself into a `$secret:` ref to have its value inlined;
 *  - `$secret:` and `$env:` are never touched here (a secret value never reaches the worker,
 *    and env was merged at compile time);
 *  - an unknown column is KEPT AS-IS, again like the compiler, so the failure shows up as a
 *    visibly bogus argument instead of a silent empty string.
 */
function bindLoopArgs(
  args: Readonly<Record<string, string>>,
  loopRow: Readonly<Record<string, string>>,
): Record<string, string> {
  const bound: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    const column = DATA_REF.exec(value)?.[1];
    bound[key] = column === undefined ? value : (loopRow[column] ?? value);
  }
  return bound;
}

async function runSteps(
  steps: readonly StepPlan[],
  caseId: string,
  deps: StepRunnerDeps,
  out: StepOutcome[],
  loopRow: Readonly<Record<string, string>>,
): Promise<void> {
  for (const step of steps) {
    if (step.kind === "action") {
      await runAction(step, caseId, deps, out, loopRow);
      continue;
    }
    if (step.kind === "for") {
      // Loop rows were resolved at compile time; the body runs once per row, in order, with that
      // row's columns bound into the body's `$data:` args. A nested `for` layers its own row on
      // top of the enclosing one, so an inner column shadows an outer column of the same name
      // while every other outer column stays visible.
      const rows: readonly DataRow[] = step.loopRows ?? [];
      for (const [i, current] of rows.entries()) {
        deps.log(
          `for-loop iteration ${i + 1}/${rows.length} (row "${current.label}") at ordinal ${step.ordinal}`,
        );
        await runSteps(step.children, caseId, deps, out, { ...loopRow, ...current.values });
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
  loopRow: Readonly<Record<string, string>>,
): Promise<void> {
  const verb = deps.resolveVerb(step.opKey);
  if (verb === undefined) {
    throw new FatalInfraError(
      `opKey "${step.opKey}" is not in the verb registry — the plan was compiled against a different build`,
    );
  }

  const args = bindLoopArgs(step.args, loopRow);
  const startedAt = deps.now();
  const running = verb.execute(deps.handle.opContext(deps.stepTimeoutMs, deps.log), args);

  // The step budget bounds the WAIT, not the work: Playwright keeps running after a lost race
  // (spike 2026-08-29), which is exactly why run-chain.ts closes the context in `finally`.
  // `raceDeadline` clears the loser's timer — an unfired one would pin this frame, and with it
  // the whole job graph, for a further 60s (soak finding, 2026-08-31).
  const result = await raceDeadline(
    running,
    deps.stepTimeoutMs,
    () => new StepTimeoutError(step.ordinal, deps.stepTimeoutMs),
  );

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
