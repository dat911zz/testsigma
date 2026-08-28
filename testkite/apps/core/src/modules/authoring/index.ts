/**
 * Module: authoring
 * Owned tables: aut_ (cases, steps, loops, rest_steps, revisions, reviews, locks, tags, priorities, types) + published_step_groups/subscriptions
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "authoring" as const;

// Facade công khai của authoring. Orchestration gọi buildCompileSnapshot ở phase 0;
// route/HTTP gọi service; KHÔNG module nào được với tay vào ./db/*.js.
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
export { getAuth, requireScope, InsufficientScopeError, type RequestAuth } from "./routes/context.js";
