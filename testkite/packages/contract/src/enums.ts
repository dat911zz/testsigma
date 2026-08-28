/**
 * Domain enum constants (docs/SYSTEM_DESIGN.md §2, §4) — LEAF module, imports nothing.
 *
 * Why this is split out of `index.ts`: the `index.ts` barrel re-exports `./schemas/index.js`,
 * and `schemas/run.ts` needs exactly these constants. Having the schema read them through the
 * barrel creates an import cycle — under real ESM the barrel's own body hasn't run yet when
 * the schema reads the constant, so it blows up with
 * `ReferenceError: Cannot access 'RUN_VERDICTS' before initialization`.
 * Putting the constants at a leaf lets both the barrel and the schema import them forward ⇒
 * cycle gone.
 *
 * Public surface is unchanged: `index.ts` re-exports this file as-is.
 */

/** Verdict of a run — compile_error/blocked happen BEFORE any browser starts. */
export const RUN_VERDICTS = [
  "passed",
  "failed",
  "compile_error",
  "blocked", // environment health gate (phase 7.5) blocked it
  "aborted_early", // mass-failure brake: first 25 chains failed with the same signature
  "cancelled",
] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

/** Job status (job_runs — queue of record in MySQL). */
export const JOB_STATUSES = [
  "pending",
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rejected_quota",
  "unknown_after_restore", // mandatory quarantine after DB restore, BEFORE the reaper runs
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ["chain", "element_verify", "capture_session", "env_probe"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const LANES = ["interactive", "batch"] as const;
export type Lane = (typeof LANES)[number];
