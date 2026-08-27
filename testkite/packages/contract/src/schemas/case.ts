/**
 * DTO authoring-facing cho case / data profile / env / snapshot compile.
 * Soi gương `AuthoredCase`, `DataProfileSnapshot`, `EnvSnapshot`, `CompileSnapshot`
 * (packages/run-compiler/src/snapshot.ts).
 */
import { z } from "zod";
import { elementSchema } from "./element.js";
import type { ElementDto } from "./element.js";
import { authoredStepSchema } from "./step.js";
import type { AuthoredStepDto } from "./step.js";

export const authoredCaseSchema = z.object({
  id: z.string().min(1),
  /** Ghim revision: schedule/CI chạy bản 'ready', sửa giữa đêm không đổi thứ đang bay. */
  revisionId: z.string().min(1),
  name: z.string().min(1),
  isStepGroup: z.boolean(),
  prereqCaseId: z.string().min(1).optional(),
  dataProfileId: z.string().min(1).optional(),
  /** Rỗng là hợp lệ: case mới tạo chưa có step; compiler quyết ngữ nghĩa, không phải biên API. */
  steps: z.array(authoredStepSchema),
});

export const dataRowSchema = z.object({
  label: z.string().min(1),
  /** BẮT BUỘC tường minh: mặc định im lặng ở đây làm lệch verdict của cả hàng dữ liệu. */
  expectedToFail: z.boolean(),
  values: z.record(z.string()),
});

export const dataProfileSchema = z.object({
  id: z.string().min(1),
  rows: z.array(dataRowSchema),
});

export const envSchema = z.object({
  baseUrl: z.string().url(),
  vars: z.record(z.string()),
  /** Chỉ TÊN secret — plan không bao giờ chứa giá trị, chỉ `$secret:<name>`. */
  secretNames: z.array(z.string().min(1)),
});

export const compileSnapshotSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  targetCaseIds: z.array(z.string().min(1)).min(1),
  cases: z.record(authoredCaseSchema),
  elements: z.record(elementSchema),
  dataProfiles: z.record(dataProfileSchema),
  env: envSchema,
});

export interface AuthoredCaseDto {
  id: string;
  revisionId: string;
  name: string;
  isStepGroup: boolean;
  prereqCaseId?: string | undefined;
  dataProfileId?: string | undefined;
  steps: AuthoredStepDto[];
}

export interface DataRowDto {
  label: string;
  expectedToFail: boolean;
  values: Record<string, string>;
}

export interface DataProfileDto {
  id: string;
  rows: DataRowDto[];
}

export interface EnvDto {
  baseUrl: string;
  vars: Record<string, string>;
  secretNames: string[];
}

export interface CompileSnapshotDto {
  teamId: string;
  projectId: string;
  targetCaseIds: string[];
  cases: Record<string, AuthoredCaseDto>;
  elements: Record<string, ElementDto>;
  dataProfiles: Record<string, DataProfileDto>;
  env: EnvDto;
}
