/**
 * Builders for TEST USE ONLY — no production module may import this file.
 * Purpose: build an authoring snapshot in a few lines, keeping tests readable like a
 * spec (and respecting `exactOptionalPropertyTypes`: an optional field is spread
 * conditionally, never explicitly assigned `undefined`).
 */
import type {
  AuthoredCase,
  AuthoredStep,
  CompileSnapshot,
  DataProfileSnapshot,
  ElementSnapshot,
} from "./snapshot.js";

export function action(
  ordinal: number,
  verbOpKey: string,
  args: Readonly<Record<string, string>> = {},
  renderedSentence = `${verbOpKey} #${ordinal}`,
): AuthoredStep {
  return { ordinal, kind: "action", verbOpKey, args, renderedSentence };
}

export function actionOn(
  ordinal: number,
  verbOpKey: string,
  elementId: string,
  args: Readonly<Record<string, string>> = {},
  renderedSentence = `${verbOpKey} #${ordinal}`,
): AuthoredStep {
  return { ordinal, kind: "action", verbOpKey, args, elementId, renderedSentence };
}

export function groupCall(
  ordinal: number,
  stepGroupCaseId: string,
  renderedSentence = `run group ${stepGroupCaseId}`,
): AuthoredStep {
  return { ordinal, kind: "step_group", stepGroupCaseId, renderedSentence };
}

export function ifStep(
  ordinal: number,
  children: readonly AuthoredStep[],
  conditionExpected: readonly string[] = ["SUCCESS"],
  renderedSentence = `if #${ordinal}`,
): AuthoredStep {
  return { ordinal, kind: "if", conditionExpected, children, renderedSentence };
}

export function forStep(
  ordinal: number,
  children: readonly AuthoredStep[],
  loopDataProfileId?: string,
  renderedSentence = `for #${ordinal}`,
): AuthoredStep {
  return {
    ordinal,
    kind: "for",
    children,
    renderedSentence,
    ...(loopDataProfileId === undefined ? {} : { loopDataProfileId }),
  };
}

export function whileStep(
  ordinal: number,
  children: readonly AuthoredStep[],
  maxIterations?: number,
  renderedSentence = `while #${ordinal}`,
): AuthoredStep {
  return {
    ordinal,
    kind: "while",
    children,
    renderedSentence,
    ...(maxIterations === undefined ? {} : { maxIterations }),
  };
}

export interface CaseOpts {
  readonly prereqCaseId?: string;
  readonly dataProfileId?: string;
  readonly isStepGroup?: boolean;
}

export function kase(id: string, steps: readonly AuthoredStep[], opts: CaseOpts = {}): AuthoredCase {
  return {
    id,
    revisionId: `rev-${id}`,
    name: id,
    isStepGroup: opts.isStepGroup ?? false,
    steps,
    ...(opts.prereqCaseId === undefined ? {} : { prereqCaseId: opts.prereqCaseId }),
    ...(opts.dataProfileId === undefined ? {} : { dataProfileId: opts.dataProfileId }),
  };
}

export function element(
  id: string,
  status: ElementSnapshot["status"] = "ready",
  locators: ElementSnapshot["locators"] = [{ kind: "css", value: `#${id}` }],
): ElementSnapshot {
  return { id, name: id, status, locators };
}

export function profile(id: string, rows: DataProfileSnapshot["rows"]): DataProfileSnapshot {
  return { id, rows };
}

export interface SnapOpts {
  readonly elements?: readonly ElementSnapshot[];
  readonly dataProfiles?: readonly DataProfileSnapshot[];
  readonly secretNames?: readonly string[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
}

export function snap(
  cases: readonly AuthoredCase[],
  targets: readonly string[],
  opts: SnapOpts = {},
): CompileSnapshot {
  return {
    teamId: "t1",
    projectId: "p1",
    targetCaseIds: targets,
    cases: Object.fromEntries(cases.map((c) => [c.id, c])),
    elements: Object.fromEntries((opts.elements ?? []).map((e) => [e.id, e])),
    dataProfiles: Object.fromEntries((opts.dataProfiles ?? []).map((p) => [p.id, p])),
    env: {
      baseUrl: opts.baseUrl ?? "https://app.example",
      vars: opts.vars ?? {},
      secretNames: opts.secretNames ?? [],
    },
  };
}
