/**
 * Phase 4+5 — element → LocatorSet, then merge data/env (blueprint §4):
 * BoundStep (has an op) → ResolvedStep (has a locator + final args).
 *
 * Phase 4 — element:
 *  The old system linked a step to an element by STRING NAME, a wrong name only surfaced
 *  once the browser had opened. Here `elementId` is looked up directly in the snapshot at
 *  compile time: missing ⇒ `element_not_found`; present but no locator captured yet ⇒
 *  `element_pending_locator`. A good step carries its immutable `LocatorSet` — the worker
 *  NEVER reads the element table at run time (a QA editing an element at midnight doesn't
 *  change what's in flight).
 *
 * Phase 5 — data/env:
 *  An arg the author wrote can be a whole-string REF, three families:
 *   - `$data:<column>` → the value from THIS iteration's data row (fanned out in phase 2).
 *   - `$env:<var>`      → the value from `env.vars`.
 *   - `$secret:<name>`  → STAYS IN REF FORM. The compiler only checks the name exists in
 *     `env.secretNames` (`secret_ref_unknown`) — the secret value is NEVER inlined into the
 *     plan, because the plan is an immutable payload that gets hashed, stored, and sent to the worker.
 *
 *  Two deliberately narrow substitution rules:
 *   - Substitute ONLY when the WHOLE arg is a ref (no interpolation mid-string) — no escape
 *     syntax needs inventing, and an author's string containing `$` is never misread.
 *   - EXACTLY ONE PASS: a substituted value is never re-interpreted. So test data can't
 *     write itself into a secret ref to exfiltrate a value.
 *  A ref pointing to an unknown name is KEPT AS-IS (not an error): inside a `for` loop body,
 *  the data column belongs to the loop row, which only the worker knows — the compiler has
 *  nothing to substitute yet.
 *
 * COLLECTS errors like previous phases: a broken action step is DROPPED from the IR (all its
 * errors are reported in full before dropping), a structural node is KEPT so its children's
 * errors still get collected.
 */
import type { CompileDiagnostic } from "./index.js";
import type { BoundActionStep, BoundCase, BoundStep } from "./phase3-bind.js";
import type { CompileSnapshot, DataRow, ElementSnapshot, EnvSnapshot } from "./snapshot.js";

/** The locator set pinned into the plan — the worker runs off exactly this, no DB lookup. */
export interface LocatorSet {
  readonly elementId: string;
  readonly elementName: string;
  readonly locators: ElementSnapshot["locators"];
}

interface ResolvedStepCommon {
  readonly ordinal: number;
  readonly renderedSentence: string;
  readonly groupPath: readonly string[];
  /** Final args: data/env already substituted, secret still `$secret:<name>`. */
  readonly args: Readonly<Record<string, string>>;
}

export interface ResolvedActionStep extends ResolvedStepCommon {
  readonly kind: "action";
  readonly opKey: string;
  /** Absent when the verb doesn't operate on any element. */
  readonly locators?: LocatorSet;
}

export interface ResolvedBlockStep extends ResolvedStepCommon {
  readonly kind: Exclude<BoundStep["kind"], "action">;
  readonly children: readonly ResolvedStep[];
  readonly conditionExpected?: readonly string[];
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
}

export type ResolvedStep = ResolvedActionStep | ResolvedBlockStep;

export interface ResolvedCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly ResolvedStep[];
  readonly iterationLabel?: string;
}

export interface Resolution {
  readonly cases: readonly ResolvedCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/** A ref occupies the WHOLE arg; column/var names keep whitespace ("Full Name" is a valid column name). */
const ARG_REF = /^\$(secret|data|env):(.+)$/;

type ArgRefKind = "secret" | "data" | "env";

interface ResolveCtx {
  readonly env: EnvSnapshot;
  readonly elements: CompileSnapshot["elements"];
  readonly caseId: string;
  readonly dataRow: Readonly<Record<string, string>>;
  /** Where diagnostics land; the 2nd+ iteration of the same case dumps into a throwaway sink (see below). */
  readonly diagnostics: CompileDiagnostic[];
}

/**
 * Resolves every bound case of ONE chain.
 *
 * Data-driven fan-out: each iteration must have ITS OWN args (that's the whole point of
 * data-driven), so the step tree can't be reused the way phase 3 does. But element/secret
 * errors are independent of the data row — diagnostics are only collected on the FIRST
 * iteration of each case, otherwise a broken element in a 500-row case would spawn 500
 * identical diagnostics.
 */
export function resolveCases(cases: readonly BoundCase[], snapshot: CompileSnapshot): Resolution {
  const out: ResolvedCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const alreadyDiagnosed = new Set<string>();

  for (const bound of cases) {
    const firstIteration = !alreadyDiagnosed.has(bound.caseId);
    alreadyDiagnosed.add(bound.caseId);

    const ctx: ResolveCtx = {
      env: snapshot.env,
      elements: snapshot.elements,
      caseId: bound.caseId,
      dataRow: bound.dataRow ?? {},
      diagnostics: firstIteration ? diagnostics : [],
    };

    out.push({
      caseId: bound.caseId,
      revisionId: bound.revisionId,
      expectedToFail: bound.expectedToFail,
      steps: resolveSteps(bound.steps, ctx),
      ...(bound.iterationLabel === undefined ? {} : { iterationLabel: bound.iterationLabel }),
    });
  }

  return { cases: out, diagnostics };
}

function resolveSteps(steps: readonly BoundStep[], ctx: ResolveCtx): readonly ResolvedStep[] {
  const out: ResolvedStep[] = [];

  for (const step of steps) {
    // A step's errors are collected separately before flushing, so a broken step still
    // reports all of its errors — in phase order (element first, args second) so the
    // diagnostics read like a compiler's own flow.
    const stepDiagnostics: CompileDiagnostic[] = [];
    const locators = step.kind === "action" ? resolveElement(step, ctx, stepDiagnostics) : undefined;
    const args = mergeArgs(step.args, ctx, step.ordinal, stepDiagnostics);

    if (step.kind !== "action") {
      ctx.diagnostics.push(...stepDiagnostics);
      out.push({
        ordinal: step.ordinal,
        kind: step.kind,
        renderedSentence: step.renderedSentence,
        groupPath: step.groupPath,
        args,
        children: resolveSteps(step.children, ctx),
        ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
        ...(step.loopRows === undefined ? {} : { loopRows: step.loopRows }),
        ...(step.maxIterations === undefined ? {} : { maxIterations: step.maxIterations }),
      });
      continue;
    }

    ctx.diagnostics.push(...stepDiagnostics);
    if (stepDiagnostics.length > 0) continue;

    out.push({
      ordinal: step.ordinal,
      kind: "action",
      renderedSentence: step.renderedSentence,
      groupPath: step.groupPath,
      args,
      opKey: step.opKey,
      ...(locators === undefined ? {} : { locators }),
    });
  }

  return out;
}

function resolveElement(
  step: BoundActionStep,
  ctx: ResolveCtx,
  sink: CompileDiagnostic[],
): LocatorSet | undefined {
  const { elementId } = step;
  if (elementId === undefined) return undefined;

  const element = ctx.elements[elementId];
  if (element === undefined) {
    sink.push({
      severity: "error",
      code: "element_not_found",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Element "${elementId}" is not in the snapshot — the step references an element that was deleted or belongs to another project`,
    });
    return undefined;
  }

  // status=ready with an empty locator is a contradictory snapshot: functionally identical to pending.
  if (element.status === "pending_locator" || element.locators.length === 0) {
    sink.push({
      severity: "error",
      code: "element_pending_locator",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Element "${elementId}" has no usable locator yet (status=${element.status}, ${element.locators.length} locators) — capture a locator before running`,
    });
    return undefined;
  }

  return { elementId: element.id, elementName: element.name, locators: element.locators };
}

function mergeArgs(
  args: Readonly<Record<string, string>>,
  ctx: ResolveCtx,
  ordinal: number,
  sink: CompileDiagnostic[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    const ref = parseArgRef(value);
    if (ref === undefined) {
      out[key] = value;
      continue;
    }

    switch (ref.kind) {
      case "secret":
        if (!ctx.env.secretNames.includes(ref.name)) {
          sink.push({
            severity: "error",
            code: "secret_ref_unknown",
            caseId: ctx.caseId,
            stepOrdinal: ordinal,
            message: `Secret "${ref.name}" (arg "${key}") is not in the environment — declare the secret before referencing it`,
          });
        }
        out[key] = value; // the ref goes straight into the plan, the value stays in the vault
        break;
      case "data":
        out[key] = ctx.dataRow[ref.name] ?? value;
        break;
      case "env":
        out[key] = ctx.env.vars[ref.name] ?? value;
        break;
    }
  }

  return out;
}

function parseArgRef(value: string): { readonly kind: ArgRefKind; readonly name: string } | undefined {
  const [, kind, name] = ARG_REF.exec(value) ?? [];
  if (name === undefined) return undefined;

  switch (kind) {
    case "secret":
    case "data":
    case "env":
      return { kind, name };
    default:
      return undefined;
  }
}
