/**
 * Module: results
 * Owned tables: res_ (case_results, step_results, artifacts, advisory_signals, run_summaries, flakiness)
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - FORWARD calls along the DAG = import the facade (this file). BACKWARD/SIDEWAYS calls = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - Repositories must be constructed with TenantContext (fail-closed) — see isolation layer L1.
 */
export const MODULE = "results" as const;

export {
  writeCaseResults,
  latestCaseResults,
  latestStepResults,
  ensureResultPartitionsSql,
  RESULT_RETENTION_DAYS,
  STEP_VERDICTS,
  type CaseResultInput,
  type StepResultInput,
  type CaseResultRow,
  type StepResultRow,
  type CaseVerdict,
  type StepVerdict,
  type WriteCaseResultsOutcome,
} from "./results-service.js";
export {
  resCaseResults,
  resCaseResultKeys,
  resStepResults,
  RESULT_VERDICTS,
  type ResultVerdict,
} from "./db/results-schema.js";
// The control-plane half of an artifact upload. The internal fleet plane (Task 13) is the only
// caller: it signs a PUT, and the bytes never enter this process.
export {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_URL_TTL_SECONDS,
  createArtifactUpload,
  markArtifactsUploaded,
  type ArtifactKind,
  type ArtifactUploadSlot,
  type CreateArtifactUploadInput,
  type S3Config,
} from "./artifacts.js";
export {
  resArtifacts,
  ARTIFACT_STATUSES,
  type ArtifactStatus,
} from "./db/artifact-schema.js";
