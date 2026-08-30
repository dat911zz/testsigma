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
export {
  startRun,
  jobCost,
  JOB_COST_MAX,
  type StartRunInput,
  type StartRunDeps,
  type StartRunResult,
} from "./run-service.js";
