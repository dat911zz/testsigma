/**
 * Phase 2 — structural expansion (blueprint §4): AuthoredStep (author's tree) → ExpandedStep (structural IR).
 *
 * Three expansions, matching the old system's verified semantics:
 *  - step_group: INLINED in place (a group = a case with isStepGroup) — the child step keeps
 *    its original renderedSentence, plus a `groupPath` provenance so QA can trace the step
 *    back to its source. 5-level nesting cap; a group calling itself falls into that same
 *    cap (the cycle is caught via depth).
 *  - if/for/while: KEPT as a node with children (the worker is the one that decides the real
 *    branch/loop) — the compiler only resolves static data: `for` gets its DataRows attached,
 *    `while` must declare an iteration cap.
 *  - data-driven at the case level: fans out each DataRow into ONE iteration (label + expected_to_fail).
 *
 * COLLECTS errors: a broken step does not stop the phase — every diagnostic from every case is gathered.
 */
import type { CompileDiagnostic } from "./index.js";
import type { AuthoredStep, CompileSnapshot, DataRow } from "./snapshot.js";

/** Step group nesting cap — inherits the old system's "allowed limit of 5" rule. */
export const MAX_STEP_GROUP_DEPTH = 5;

/** step_group disappears after phase 2 (already inlined); the remaining kinds carry on to the plan. */
export type ExpandedStepKind = "action" | "if" | "for" | "while" | "rest";

export interface ExpandedStep {
  /** Ordinal within the case/group CONTAINING the step — used to point authors at the error. */
  readonly ordinal: number;
  readonly kind: ExpandedStepKind;
  readonly renderedSentence: string;
  /** The chain of step-group ids inlined to reach this step; empty = the step is written directly in the case. */
  readonly groupPath: readonly string[];
  readonly args: Readonly<Record<string, string>>;
  readonly verbOpKey?: string;
  readonly elementId?: string;
  readonly conditionExpected?: readonly string[];
  /** kind=for: loop data already resolved from the profile (immutable within the plan). */
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
  readonly children?: readonly ExpandedStep[];
}

export interface ExpandedCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly ExpandedStep[];
  /** data-driven: this iteration's data-row label. */
  readonly iterationLabel?: string;
  /** data-driven: the row's values — phase 5 merges these into args. */
  readonly dataRow?: Readonly<Record<string, string>>;
}

export interface Expansion {
  readonly cases: readonly ExpandedCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

interface ExpandCtx {
  readonly snapshot: CompileSnapshot;
  /** The root case being expanded — diagnostics always attribute to the case QA sees, not an internal group. */
  readonly caseId: string;
  readonly diagnostics: CompileDiagnostic[];
}

/** Expands a list of cases (usually the cases of ONE chain, in execution order). */
export function expandCases(snapshot: CompileSnapshot, caseIds: readonly string[]): Expansion {
  const cases: ExpandedCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];

  for (const caseId of caseIds) {
    const authored = snapshot.cases[caseId];
    if (authored === undefined) continue; // phase 1 already reported prereq_missing

    const ctx: ExpandCtx = { snapshot, caseId, diagnostics };
    const steps = expandSteps(authored.steps, ctx, []);

    const profileId = authored.dataProfileId;
    if (profileId === undefined) {
      cases.push({ caseId, revisionId: authored.revisionId, expectedToFail: false, steps });
      continue;
    }

    const rows = snapshot.dataProfiles[profileId]?.rows ?? [];
    if (rows.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "data_profile_empty",
        caseId,
        message: `Case "${caseId}" runs off data profile "${profileId}" but the profile is empty or missing from the snapshot`,
      });
      continue;
    }

    for (const row of rows) {
      cases.push({
        caseId,
        revisionId: authored.revisionId,
        expectedToFail: row.expectedToFail,
        steps,
        iterationLabel: row.label,
        dataRow: row.values,
      });
    }
  }

  return { cases, diagnostics };
}

function expandSteps(
  steps: readonly AuthoredStep[],
  ctx: ExpandCtx,
  groupPath: readonly string[],
): readonly ExpandedStep[] {
  const out: ExpandedStep[] = [];

  for (const step of steps) {
    if (step.kind === "step_group") {
      out.push(...inlineGroup(step, ctx, groupPath));
      continue;
    }

    const children =
      step.children === undefined ? undefined : expandSteps(step.children, ctx, groupPath);

    out.push({
      ordinal: step.ordinal,
      kind: step.kind,
      renderedSentence: step.renderedSentence,
      groupPath,
      args: step.args ?? {},
      ...(step.verbOpKey === undefined ? {} : { verbOpKey: step.verbOpKey }),
      ...(step.elementId === undefined ? {} : { elementId: step.elementId }),
      ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
      ...(children === undefined ? {} : { children }),
      ...(step.kind === "for" ? loopRowsOf(step, ctx) : {}),
      ...(step.kind === "while" ? maxIterationsOf(step, ctx) : {}),
    });
  }

  return out;
}

function inlineGroup(
  step: AuthoredStep,
  ctx: ExpandCtx,
  groupPath: readonly string[],
): readonly ExpandedStep[] {
  const targetId = step.stepGroupCaseId;
  const target = targetId === undefined ? undefined : ctx.snapshot.cases[targetId];

  if (targetId === undefined || target === undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "step_group_missing",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Step group "${targetId ?? "(not declared)"}" does not exist in the snapshot`,
    });
    return [];
  }

  if (groupPath.length >= MAX_STEP_GROUP_DEPTH) {
    ctx.diagnostics.push({
      severity: "error",
      code: "step_group_depth_exceeded",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Expanding step group "${targetId}" exceeds the ${MAX_STEP_GROUP_DEPTH}-level cap (expansion path: ${[...groupPath, targetId].join(" → ")})`,
    });
    return [];
  }

  return expandSteps(target.steps, ctx, [...groupPath, targetId]);
}

function loopRowsOf(step: AuthoredStep, ctx: ExpandCtx): { loopRows?: readonly DataRow[] } {
  const profileId = step.loopDataProfileId;
  const rows = profileId === undefined ? [] : (ctx.snapshot.dataProfiles[profileId]?.rows ?? []);
  if (rows.length === 0) {
    ctx.diagnostics.push({
      severity: "error",
      code: "data_profile_empty",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `A "for" loop needs a data profile with at least 1 row (profile: ${profileId ?? "not declared"})`,
    });
    return {};
  }
  return { loopRows: rows };
}

function maxIterationsOf(step: AuthoredStep, ctx: ExpandCtx): { maxIterations?: number } {
  if (step.maxIterations === undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "while_without_max_iterations",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `A "while" loop must declare maxIterations — no iteration cap is a ticket to an infinite hang`,
    });
    return {};
  }
  return { maxIterations: step.maxIterations };
}
