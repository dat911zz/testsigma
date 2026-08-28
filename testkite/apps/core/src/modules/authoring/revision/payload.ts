/**
 * Snapshot shape stored in `aut_case_revisions.payload` (after canonical + zstd).
 *
 * Has NO `ordinal`: position is encoded via `after` = the id of the preceding step with
 * the SAME parent. Measured reason (spike 2026-08-28): ordinal is a number, so inserting
 * a step renumbers the entire tail ⇒ every diff algorithm reports N changes for 1 action.
 * With `after`, inserting a step touches exactly two entries.
 */
import type { StepKindDto } from "@testkite/contract";

export interface RevisionLoop {
  readonly dataProfileId?: string;
  readonly maxIterations?: number;
}

export interface RevisionRest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly storeAs?: string;
}

export interface RevisionStep {
  readonly id: string;
  readonly kind: StepKindDto;
  /** null = the case's root step. */
  readonly parentId: string | null;
  /** null = the first step in the sibling list. */
  readonly after: string | null;
  readonly renderedSentence: string;
  readonly verbOpKey?: string;
  readonly elementId?: string;
  readonly args?: Record<string, string>;
  readonly stepGroupCaseId?: string;
  readonly conditionExpected?: readonly string[];
  readonly loop?: RevisionLoop;
  readonly rest?: RevisionRest;
}

export interface RevisionCase {
  readonly name: string;
  readonly isStepGroup: boolean;
  readonly prereqCaseId?: string;
  readonly dataProfileId?: string;
}

export interface RevisionPayload {
  readonly case: RevisionCase;
  /** A FLAT list of every step (including children) — the tree is rebuilt from parentId + after. */
  readonly steps: readonly RevisionStep[];
}
