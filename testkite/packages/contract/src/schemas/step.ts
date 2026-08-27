/**
 * DTO authoring-facing cho step. Soi gương `AuthoredStep`
 * (packages/run-compiler/src/snapshot.ts).
 *
 * HAI RÀNG BUỘC KHÔNG ĐƯỢC BỎ:
 *  1. Đệ quy (`children`) ⇒ phải khai type thủ công rồi chú thích
 *     `z.ZodType<AuthoredStepDto>` + `z.lazy(...)`.
 *  2. `exactOptionalPropertyTypes: true` ⇒ prop optional viết `?: T | undefined`.
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
  /** BẮT BUỘC: while không trần lặp là while vô hạn (compiler: while_without_max_iterations). */
  maxIterations: number;
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

/** Trường chung mọi kind — ordinal đếm từ 1 (khớp fixture run-compiler). */
const stepCommon = {
  ordinal: z.number().int().positive(),
  renderedSentence: z.string().min(1),
};

/** args luôn là bản đồ chuỗi→chuỗi: secret đi qua compiler ở dạng `$secret:<name>`. */
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
      maxIterations: z.number().int().positive(),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("rest"),
      ...stepCommon,
      args: argsSchema.optional(),
    }),
  ]),
);
