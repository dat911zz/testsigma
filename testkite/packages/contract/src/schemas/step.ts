/**
 * Authoring-facing DTO for a step. Mirrors `AuthoredStep`
 * (packages/run-compiler/src/snapshot.ts).
 *
 * TWO CONSTRAINTS THAT MUST NOT BE DROPPED:
 *  1. Recursive (`children`) ⇒ must hand-declare the type and annotate with
 *     `z.ZodType<AuthoredStepDto>` + `z.lazy(...)`.
 *  2. `exactOptionalPropertyTypes: true` ⇒ optional props are written `?: T | undefined`.
 */
import { z } from "zod";

export const STEP_KINDS = ["action", "step_group", "if", "for", "while", "rest"] as const;
export const stepKindSchema = z.enum(STEP_KINDS);
export type StepKindDto = (typeof STEP_KINDS)[number];

export interface ActionStepDto {
  kind: "action";
  ordinal: number;
  renderedSentence: string;
  verbOpKey: string;
  args?: Record<string, string> | undefined;
  elementId?: string | undefined;
}

export interface StepGroupStepDto {
  kind: "step_group";
  ordinal: number;
  renderedSentence: string;
  stepGroupCaseId: string;
}

export interface IfStepDto {
  kind: "if";
  ordinal: number;
  renderedSentence: string;
  conditionExpected: string[];
  children: AuthoredStepDto[];
}

export interface ForStepDto {
  kind: "for";
  ordinal: number;
  renderedSentence: string;
  loopDataProfileId: string;
  children: AuthoredStepDto[];
}

export interface WhileStepDto {
  kind: "while";
  ordinal: number;
  renderedSentence: string;
  /**
   * NOT required at the API boundary: a while with no iteration cap is valid
   * authoring data, and the COMPILER is the one that judges it (diagnostic
   * `while_without_max_iterations`, fixture err-while-without-max-iterations.json).
   * Returning 400 here would cut out the batched-in-one-pass diagnostics the author
   * needs to fix every error in one round.
   */
  maxIterations?: number | undefined;
  children: AuthoredStepDto[];
}

export interface RestStepDto {
  kind: "rest";
  ordinal: number;
  renderedSentence: string;
  args?: Record<string, string> | undefined;
}

export type AuthoredStepDto =
  | ActionStepDto
  | StepGroupStepDto
  | IfStepDto
  | ForStepDto
  | WhileStepDto
  | RestStepDto;

/** Fields common to every kind — ordinal counts from 1 (matches run-compiler fixtures). */
const stepCommon = {
  ordinal: z.number().int().positive(),
  renderedSentence: z.string().min(1),
};

/** args is always a string→string map: secrets pass through the compiler as `$secret:<name>`. */
const argsSchema = z.record(z.string());

export const authoredStepSchema: z.ZodType<AuthoredStepDto> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("action"),
      ...stepCommon,
      verbOpKey: z.string().min(1),
      args: argsSchema.optional(),
      elementId: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("step_group"),
      ...stepCommon,
      stepGroupCaseId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("if"),
      ...stepCommon,
      conditionExpected: z.array(z.string().min(1)).min(1),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("for"),
      ...stepCommon,
      loopDataProfileId: z.string().min(1),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("while"),
      ...stepCommon,
      maxIterations: z.number().int().positive().optional(),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("rest"),
      ...stepCommon,
      args: argsSchema.optional(),
    }),
  ]),
);
