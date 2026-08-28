/**
 * Module: authoring
 * Owned tables: aut_ (cases, steps, loops, rest_steps, revisions, reviews, locks, tags, priorities, types) + published_step_groups/subscriptions
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - FORWARD calls along the DAG = import the facade (this file). BACKWARD/SIDEWAYS calls = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - Repositories must be constructed with TenantContext (fail-closed) — see isolation layer L1.
 */
export const MODULE = "authoring" as const;

// Public facade of authoring. Orchestration calls buildCompileSnapshot at phase 0;
// routes/HTTP call the service; NO module is allowed to reach into ./db/*.js directly.
export { createCase, replaceSteps, toCaseSummary, type Actor } from "./case-service.js";
export {
  decideReview,
  promoteCase,
  submitForReview,
  withdrawReview,
  type CaseMutationInput,
  type DecideReviewInput,
} from "./review-service.js";
export {
  buildCompileSnapshot,
  revisionPayloadToAuthoredCase,
  MAX_SNAPSHOT_CASES,
  type SnapshotDeps,
  type SnapshotInput,
  type SnapshotPin,
} from "./snapshot.js";
export { formatETag, parseIfMatch } from "./concurrency.js";
export {
  CaseNotFoundError,
  CaseStateError,
  FourEyesViolationError,
  IfMatchRequiredError,
  VersionConflictError,
} from "./errors.js";
// HTTP surface: a FastifyPluginAsync factory registered by the shell after the auth
// hook. `getAuth`/`requireScope` are the single adapter onto the identity request
// context; nothing else in authoring touches its shape.
export { authoringRoutes } from "./routes/cases.js";
export {
  getAuth,
  requireScope,
  InsufficientScopeError,
  type RequestAuth,
  type ScopedDescriptor,
} from "./routes/context.js";
