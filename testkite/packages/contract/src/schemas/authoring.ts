/**
 * Authoring-facing DTO for the case LIFECYCLE (different from `./case.js` — that
 * one is the DTO the COMPILER reads). Two directions, two shapes:
 *   - AuthoredStep  (./step.js) : compiler reads it — has `ordinal`, no `id`.
 *   - StepInput     (this file) : the author submits it — has an optional `id`, NO `ordinal`.
 * The optional `id` is what keeps a step's identity across edits; without it the
 * three-way diff reports "whole case replaced" on every save (measured in the
 * 2026-08-28 spike).
 */
import { z } from "zod";

export const CASE_STATUSES = ["draft", "in_review", "ready"] as const;
export const caseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatusDto = (typeof CASE_STATUSES)[number];

export const REVIEW_DECISIONS = ["approved", "changes_requested"] as const;
export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecisionDto = (typeof REVIEW_DECISIONS)[number];

export const CHANGE_KINDS = ["added", "removed", "modified"] as const;
export const changeKindSchema = z.enum(CHANGE_KINDS);
export type ChangeKindDto = (typeof CHANGE_KINDS)[number];

const argsSchema = z.record(z.string());

export interface ActionStepInputDto {
  id?: string | undefined;
  kind: "action";
  renderedSentence: string;
  verbOpKey: string;
  args?: Record<string, string> | undefined;
  elementId?: string | undefined;
}
export interface StepGroupStepInputDto {
  id?: string | undefined;
  kind: "step_group";
  renderedSentence: string;
  stepGroupCaseId: string;
}
export interface IfStepInputDto {
  id?: string | undefined;
  kind: "if";
  renderedSentence: string;
  conditionExpected: string[];
  children: StepInputDto[];
}
export interface ForStepInputDto {
  id?: string | undefined;
  kind: "for";
  renderedSentence: string;
  loopDataProfileId: string;
  children: StepInputDto[];
}
export interface WhileStepInputDto {
  id?: string | undefined;
  kind: "while";
  renderedSentence: string;
  /** Not required at the API boundary — the COMPILER decides (diagnostic while_without_max_iterations). */
  maxIterations?: number | undefined;
  children: StepInputDto[];
}
export interface RestStepInputDto {
  id?: string | undefined;
  kind: "rest";
  renderedSentence: string;
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  storeAs?: string | undefined;
}

export type StepInputDto =
  | ActionStepInputDto
  | StepGroupStepInputDto
  | IfStepInputDto
  | ForStepInputDto
  | WhileStepInputDto
  | RestStepInputDto;

const inputCommon = {
  id: z.string().min(1).optional(),
  renderedSentence: z.string().min(1),
};

export const stepInputSchema: z.ZodType<StepInputDto> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("action"),
      ...inputCommon,
      verbOpKey: z.string().min(1),
      args: argsSchema.optional(),
      elementId: z.string().min(1).optional(),
    }),
    z.object({ kind: z.literal("step_group"), ...inputCommon, stepGroupCaseId: z.string().min(1) }),
    z.object({
      kind: z.literal("if"),
      ...inputCommon,
      conditionExpected: z.array(z.string().min(1)).min(1),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("for"),
      ...inputCommon,
      loopDataProfileId: z.string().min(1),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("while"),
      ...inputCommon,
      maxIterations: z.number().int().positive().optional(),
      children: z.array(stepInputSchema),
    }),
    z.object({
      kind: z.literal("rest"),
      ...inputCommon,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
      url: z.string().min(1),
      headers: argsSchema.optional(),
      body: z.string().optional(),
      storeAs: z.string().min(1).optional(),
    }),
  ]),
);

/** Response body for GET/POST case. `version` is the source of the ETag. */
export const caseSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  isStepGroup: z.boolean(),
  status: caseStatusSchema,
  version: z.number().int().positive(),
  prereqCaseId: z.string().min(1).optional(),
  dataProfileId: z.string().min(1).optional(),
  latestRevisionId: z.string().min(1).optional(),
  readyRevisionId: z.string().min(1).optional(),
  lastEditedBy: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  submittedAt: z.string().min(1).optional(),
  reviewedAt: z.string().min(1).optional(),
  promotedAt: z.string().min(1).optional(),
});

export interface CaseSummaryDto {
  id: string;
  projectId: string;
  name: string;
  isStepGroup: boolean;
  status: CaseStatusDto;
  version: number;
  prereqCaseId?: string | undefined;
  dataProfileId?: string | undefined;
  latestRevisionId?: string | undefined;
  readyRevisionId?: string | undefined;
  lastEditedBy?: string | undefined;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | undefined;
  reviewedAt?: string | undefined;
  promotedAt?: string | undefined;
}

/**
 * One change = one PATH. `/name`, `/steps/<stepId>` (add/remove a whole step),
 * `/steps/<stepId>/<field>` (edit one field). `after` is a valid field: it carries
 * position (the preceding step's id) instead of a numeric ordinal — which is why
 * inserting one step produces only 2 entries instead of 4 (measured for real in
 * the 2026-08-28 spike).
 */
export const caseChangeSchema = z.object({
  path: z.string().min(1),
  kind: changeKindSchema,
  base: z.unknown().optional(),
  value: z.unknown().optional(),
});

export interface CaseChangeDto {
  path: string;
  kind: ChangeKindDto;
  base?: unknown;
  value?: unknown;
}

/** 409 response body: three markers + two change branches + their intersection. */
export const threeWayDiffSchema = z.object({
  baseVersion: z.number().int().positive(),
  baseRevisionId: z.string().min(1),
  currentVersion: z.number().int().positive(),
  currentRevisionId: z.string().min(1),
  /** base → the version the client submitted. */
  mine: z.array(caseChangeSchema),
  /** base → the version currently on the server. */
  theirs: z.array(caseChangeSchema),
  /** A path that appears in BOTH branches — where the user must decide themselves. */
  conflicts: z.array(z.string().min(1)),
});

export interface ThreeWayDiffDto {
  baseVersion: number;
  baseRevisionId: string;
  currentVersion: number;
  currentRevisionId: string;
  mine: CaseChangeDto[];
  theirs: CaseChangeDto[];
  conflicts: string[];
}
