/**
 * Phase 3 — bind verb (blueprint §4): ExpandedStep (structural IR) → BoundStep (IR with an op).
 *
 * This is where the old system's `Class.forName(...)` gets replaced: a verb is no longer
 * resolved at runtime by reflecting on a class name (errors surfaced after the browser had
 * already run through half the suite) — instead it looks up the @testkite/verb-kit registry
 * right at compile time — a wrong op key or a missing param is a `compile_error`, before a
 * single second of browser time is spent.
 *
 * Two rules:
 *  - COLLECT EVERY ERROR: a broken step does not stop the phase; a broken step is DROPPED
 *    from the IR so the `BoundActionStep` type keeps the invariant "opKey exists + args are
 *    valid" (a plan is only produced when diagnostics are empty, so dropping a step never
 *    loses plan data).
 *  - Structural nodes (if/for/while/rest) do NOT bind a verb — they only recurse into
 *    children, keeping the static data phase 2 already resolved (loopRows, maxIterations, condition).
 */
import { getVerb, validateArgs } from "@testkite/verb-kit";
import type { CompileDiagnostic } from "./index.js";
import type { ExpandedCase, ExpandedStep, ExpandedStepKind } from "./phase2-expand.js";
import type { DataRow } from "./snapshot.js";

interface BoundStepCommon {
  readonly ordinal: number;
  readonly renderedSentence: string;
  /** Step-group provenance from phase 2 — kept as-is so QA can trace the step back to its source. */
  readonly groupPath: readonly string[];
  readonly args: Readonly<Record<string, string>>;
}

/** A bound step: opKey is GUARANTEED to exist in the registry and args are GUARANTEED valid for that verb. */
export interface BoundActionStep extends BoundStepCommon {
  readonly kind: "action";
  readonly opKey: string;
  /** Element reference — phase 4 is where this turns into a LocatorSet. */
  readonly elementId?: string;
}

export interface BoundBlockStep extends BoundStepCommon {
  readonly kind: Exclude<ExpandedStepKind, "action">;
  readonly children: readonly BoundStep[];
  readonly conditionExpected?: readonly string[];
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
}

export type BoundStep = BoundActionStep | BoundBlockStep;

export interface BoundCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly BoundStep[];
  readonly iterationLabel?: string;
  readonly dataRow?: Readonly<Record<string, string>>;
}

export interface Binding {
  readonly cases: readonly BoundCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/** Binds every case of ONE chain (input order = execution order, preserved). */
export function bindCases(cases: readonly ExpandedCase[]): Binding {
  const out: BoundCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  /**
   * A data-driven fan-out with N iterations SHARES one step tree: bind it once and reuse —
   * otherwise an unknown verb in a 500-row case would spawn 500 identical diagnostics.
   */
  const boundByCase = new Map<string, readonly BoundStep[]>();

  for (const expanded of cases) {
    let steps = boundByCase.get(expanded.caseId);
    if (steps === undefined) {
      steps = bindSteps(expanded.steps, expanded.caseId, diagnostics);
      boundByCase.set(expanded.caseId, steps);
    }

    out.push({
      caseId: expanded.caseId,
      revisionId: expanded.revisionId,
      expectedToFail: expanded.expectedToFail,
      steps,
      ...(expanded.iterationLabel === undefined ? {} : { iterationLabel: expanded.iterationLabel }),
      ...(expanded.dataRow === undefined ? {} : { dataRow: expanded.dataRow }),
    });
  }

  return { cases: out, diagnostics };
}

function bindSteps(
  steps: readonly ExpandedStep[],
  caseId: string,
  diagnostics: CompileDiagnostic[],
): readonly BoundStep[] {
  const out: BoundStep[] = [];

  for (const step of steps) {
    if (step.kind !== "action") {
      out.push({
        ordinal: step.ordinal,
        kind: step.kind,
        renderedSentence: step.renderedSentence,
        groupPath: step.groupPath,
        args: step.args,
        children: bindSteps(step.children ?? [], caseId, diagnostics),
        ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
        ...(step.loopRows === undefined ? {} : { loopRows: step.loopRows }),
        ...(step.maxIterations === undefined ? {} : { maxIterations: step.maxIterations }),
      });
      continue;
    }

    const opKey = step.verbOpKey;
    if (opKey === undefined || getVerb(opKey) === undefined) {
      diagnostics.push({
        severity: "error",
        code: "unknown_verb",
        caseId,
        stepOrdinal: step.ordinal,
        message: `Verb "${opKey ?? "(not declared)"}" is not in the @testkite/verb-kit registry — not yet ported or a wrong op key`,
      });
      continue;
    }

    const check = validateArgs(opKey, argsForCheck(step));
    if (!check.ok) {
      diagnostics.push({
        severity: "error",
        code: "verb_args_invalid",
        caseId,
        stepOrdinal: step.ordinal,
        message: `Args for verb "${opKey}" are invalid: ${check.issues.join("; ")}`,
      });
      continue;
    }

    out.push({
      ordinal: step.ordinal,
      kind: "action",
      renderedSentence: step.renderedSentence,
      groupPath: step.groupPath,
      args: step.args,
      opKey,
      ...(step.elementId === undefined ? {} : { elementId: step.elementId }),
    });
  }

  return out;
}

/**
 * A step's element lives in its own column (`elementId`), not in args — but the verb
 * declares it as a param. Merged back in only for CHECKING: the author's original args
 * stay unchanged in the IR; phase 4 is where elementId actually turns into a LocatorSet.
 */
function argsForCheck(step: ExpandedStep): Record<string, string> {
  const { elementId } = step;
  if (elementId === undefined || "element" in step.args) return { ...step.args };
  return { ...step.args, element: elementId };
}
