/**
 * Run DTO + the compile-error code catalog.
 *
 * `COMPILE_ERROR_CODES` LIVES HERE rather than in run-compiler: contract must not
 * import run-compiler (that would reverse the DAG), yet `runSchema` needs this
 * catalog. run-compiler re-exports it — it already depends on contract, so this
 * direction is the only forward direction that keeps a SINGLE list.
 */
import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES, LANES, RUN_VERDICTS } from "../enums.js";

export const runVerdictSchema = z.enum(RUN_VERDICTS);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const jobKindSchema = z.enum(JOB_KINDS);
export const laneSchema = z.enum(LANES);

/**
 * DATA, not just a type: the compiler's golden suite iterates this array AT RUNTIME
 * to prove "every code has ≥1 negative fixture". Order = the phase 1→5 flow.
 */
export const COMPILE_ERROR_CODES = [
  "prereq_cycle",
  "prereq_depth_exceeded",
  "prereq_missing",
  "step_group_depth_exceeded",
  "step_group_missing",
  "unknown_verb",
  "verb_args_invalid",
  "element_pending_locator",
  "element_not_found",
  "secret_ref_unknown",
  "while_without_max_iterations",
  "data_profile_empty",
] as const;

export type CompileErrorCode = (typeof COMPILE_ERROR_CODES)[number];

export const compileErrorCodeSchema = z.enum(COMPILE_ERROR_CODES);

export const compileDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: compileErrorCodeSchema,
  caseId: z.string().min(1),
  /** Absent = case-level error (prereq cycle...), not step-level. */
  stepOrdinal: z.number().int().positive().optional(),
  message: z.string().min(1),
});

/** Lowercase SHA-256 hex — matches phase 7's `contentHashOf`. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const runSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  lane: laneSchema,
  status: jobStatusSchema,
  verdict: runVerdictSchema,
  /** Absent when verdict=compile_error: no plan means no hash. */
  planContentHash: contentHashSchema.optional(),
  diagnostics: z.array(compileDiagnosticSchema),
});

export interface CompileDiagnosticDto {
  severity: "error" | "warning";
  code: CompileErrorCode;
  caseId: string;
  stepOrdinal?: number | undefined;
  message: string;
}

export interface RunDto {
  id: string;
  teamId: string;
  projectId: string;
  lane: (typeof LANES)[number];
  status: (typeof JOB_STATUSES)[number];
  verdict: (typeof RUN_VERDICTS)[number];
  planContentHash?: string | undefined;
  diagnostics: CompileDiagnosticDto[];
}
