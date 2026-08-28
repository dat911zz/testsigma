/**
 * Module: planning
 * Owned tables: pln_ (suites, plans, run_targets, environments, schedules)
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "planning" as const;

// Facade công khai của planning. Bản M2 chỉ có phần tối thiểu cho onboarding.
export { plnEnvironments, plnEnvStatus } from "./db/schema.js";
export { seedEnvironmentStubs, ONBOARD_ENV_NAMES } from "./onboarding.js";
