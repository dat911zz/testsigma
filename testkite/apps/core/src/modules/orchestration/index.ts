/**
 * Module: orchestration
 * Owned tables: orc_ (runs, run_plans, workers, compile_diagnostics), job_runs (QUEUE OF RECORD + lease authority), egress_policies, migration_state
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - FORWARD calls along the DAG = import the facade (this file). BACKWARD/SIDEWAYS calls = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - Repositories must be constructed with TenantContext (fail-closed) — see isolation layer L1.
 */
export const MODULE = "orchestration" as const;

// Public facade of orchestration. The M2 build only has the minimum needed for onboarding.
export { egressPolicies, egressMode } from "./db/schema.js";
export { seedEgressObserve, EGRESS_OBSERVE_DAYS } from "./onboarding.js";
export {
  orcRuns,
  orcRunPlans,
  orcCompileDiagnostics,
  runLane,
  runStatus,
  runVerdict,
  runPin,
} from "./db/run-schema.js";
// The queue of record. Exported because `res_artifacts` (results) carries a composite FK
// (team_id, job_run_id) into it — the DAG allows results -> orchestration, and the FK is what
// makes an artifact on another team's job unrepresentable rather than merely unchecked.
export { jobRuns } from "./db/job-schema.js";
export { orcDispatcherLease, orcWorkers, orcRunTokens, orcRunEvents } from "./db/fleet-schema.js";
// The two credentials of a zero-credential worker. Exported through the facade because the
// internal fleet plane (Task 13) authenticates with them and nothing else may reach past it.
export {
  RUN_TOKEN_TTL_SLACK_SECONDS,
  WORKER_TOKEN_TTL_HOURS,
  mintRunToken,
  registerWorker,
  revokeRunTokensFor,
  touchWorker,
  verifyRunToken,
  verifyWorkerToken,
  type RunTokenScope,
  type WorkerTokenScope,
} from "./run-token.js";
// The worker's narration. The internal fleet plane (Task 13) records it and the SSE stream
// (Task 14) replays it; `RUN_EVENT_KINDS` is the closed enum both of them validate against.
export {
  RUN_EVENT_KINDS,
  readRunEvents,
  recordRunEvent,
  type RecordEventInput,
  type RunEventKind,
  type StoredRunEvent,
} from "./events.js";
// The ownership protocol itself. Exported because the internal fleet plane (Task 13) is the
// only caller that ever holds a lease: it claims, fences, heartbeats and completes on behalf of
// a worker that has no database credential of its own.
export {
  claimJobs,
  completeJob,
  dispatchPending,
  fenceJob,
  heartbeatJob,
  jobExistsForTeam,
  LEASE_SECONDS,
  MAX_INFRA_ATTEMPTS,
  type ClaimedJobRow,
  type EpochOutcome,
  type FencedJob,
  type JobLane,
} from "./queue/job-queue.js";
export {
  readRunPlan,
  startRun,
  jobCost,
  JOB_COST_MAX,
  type FrozenRunPlan,
  type StartRunInput,
  type StartRunDeps,
  type StartRunResult,
} from "./run-service.js";
