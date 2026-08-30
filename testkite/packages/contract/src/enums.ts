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

/**
 * Lifecycle of the RUN AGGREGATE (`orc_runs.status`) — not to be confused with `JOB_STATUSES`,
 * which is the state of ONE chain in the queue. A run is `finished` the moment it has a
 * verdict, including the verdicts reached before any browser started (compile_error, blocked).
 */
export const RUN_LIFECYCLE_STATUSES = ["compiling", "queued", "running", "finished"] as const;
export type RunLifecycleStatus = (typeof RUN_LIFECYCLE_STATUSES)[number];

/**
 * `orc_runs.verdict` carries one value the tenant-facing `RUN_VERDICTS` does not: `pending`,
 * the state of a run that has not reached a verdict yet. It is a READ-side value only —
 * nothing ever finishes with it.
 */
export const RUN_VERDICTS_WITH_PENDING = ["pending", ...RUN_VERDICTS] as const;
export type RunVerdictWithPending = (typeof RUN_VERDICTS_WITH_PENDING)[number];
