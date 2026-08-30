/**
 * Module: planning
 * Owned tables: pln_ (suites, plans, run_targets, environments, schedules)
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - FORWARD calls along the DAG = import the facade (this file). BACKWARD/SIDEWAYS calls = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - Repositories must be constructed with TenantContext (fail-closed) — see isolation layer L1.
 */
export const MODULE = "planning" as const;

// Public facade of planning. The M2 build only has the minimum needed for onboarding.
export { plnEnvironments, plnEnvStatus } from "./db/schema.js";
export { seedEnvironmentStubs, ONBOARD_ENV_NAMES } from "./onboarding.js";
// Orchestration's phase 0 loads the run environment through here: authoring may not import
// planning (wrong way round the DAG), so `env` reaches the snapshot as a parameter instead.
export { loadRunEnvironment, EnvironmentNotFoundError } from "./environment.js";
