/**
 * Authoring-facing DTO for case / data profile / env / compile snapshot.
 * Mirrors `AuthoredCase`, `DataProfileSnapshot`, `EnvSnapshot`, `CompileSnapshot`
 * (packages/run-compiler/src/snapshot.ts).
 */
import { z } from "zod";
import { elementSchema } from "./element.js";
import type { ElementDto } from "./element.js";
import { authoredStepSchema } from "./step.js";
import type { AuthoredStepDto } from "./step.js";

export const authoredCaseSchema = z.object({
  id: z.string().min(1),
  /** Pins a revision: schedule/CI runs the 'ready' version, a midnight edit doesn't change what's in flight. */
  revisionId: z.string().min(1),
  name: z.string().min(1),
  isStepGroup: z.boolean(),
  prereqCaseId: z.string().min(1).optional(),
  dataProfileId: z.string().min(1).optional(),
  /** Empty is valid: a newly created case has no steps yet; the compiler decides the semantics, not the API boundary. */
  steps: z.array(authoredStepSchema),
});

export const dataRowSchema = z.object({
  label: z.string().min(1),
  /** MUST be explicit: a silent default here would skew the verdict of the whole data row. */
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
  /** Only the secret NAME — the plan never contains the value, only `$secret:<name>`. */
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
