/**
 * CompileInput snapshot — pre-fetched by orchestration, the compiler does NO I/O.
 * Mirrors the verified semantics of the old system (blueprint §2):
 * prereq = case chain; step group = a case with isStepGroup; a loop runs over a data profile.
 */

export type StepKind = "action" | "step_group" | "if" | "for" | "while" | "rest";

export interface AuthoredStep {
  readonly ordinal: number;
  readonly kind: StepKind;
  /** kind=action: the op key in the verb-kit registry. */
  readonly verbOpKey?: string;
  readonly args?: Readonly<Record<string, string>>;
  /** kind=action: the element reference name (already an id in the new system). */
  readonly elementId?: string;
  /** kind=step_group: the case (isStepGroup=true) being called. */
  readonly stepGroupCaseId?: string;
  /** kind=if: the branch's expected outcome (["SUCCESS"] ...). */
  readonly conditionExpected?: readonly string[];
  /** kind=for: the data profile that feeds the loop. */
  readonly loopDataProfileId?: string;
  /**
   * kind=while: NOT required at this boundary — a while with no iteration cap is valid
   * authoring data (contract/schemas/step.ts). The compiler is what judges it, raising the
   * `while_without_max_iterations` diagnostic instead of rejecting at the API edge, so an
   * author gets every error batched into one pass rather than one at a time.
   */
  readonly maxIterations?: number;
  /** The NLP sentence shown to QA in the results. */
  readonly renderedSentence: string;
  /** if/for/while: child steps. */
  readonly children?: readonly AuthoredStep[];
}

export interface AuthoredCase {
  readonly id: string;
  readonly revisionId: string;
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string;
  /** data-driven: profile + the row count already fetched. */
  readonly dataProfileId?: string;
  readonly steps: readonly AuthoredStep[];
}

export interface ElementSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: "ready" | "pending_locator";
  readonly locators: readonly { readonly kind: string; readonly value: string }[];
}

export interface DataRow {
  readonly label: string;
  readonly expectedToFail: boolean;
  readonly values: Readonly<Record<string, string>>;
}

export interface DataProfileSnapshot {
  readonly id: string;
  readonly rows: readonly DataRow[];
}

export interface EnvSnapshot {
  readonly baseUrl: string;
  readonly vars: Readonly<Record<string, string>>;
  /** Valid secret names — the plan may only contain $secret:<name>, never the value. */
  readonly secretNames: readonly string[];
}

export interface CompileSnapshot {
  readonly teamId: string;
  readonly projectId: string;
  /** The cases requested to run (chain roots). */
  readonly targetCaseIds: readonly string[];
  /** Every case involved (including prereqs + step groups), keyed by id. */
  readonly cases: Readonly<Record<string, AuthoredCase>>;
  readonly elements: Readonly<Record<string, ElementSnapshot>>;
  readonly dataProfiles: Readonly<Record<string, DataProfileSnapshot>>;
  readonly env: EnvSnapshot;
}
