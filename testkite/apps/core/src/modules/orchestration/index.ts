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
