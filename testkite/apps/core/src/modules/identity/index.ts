/**
 * Module: identity
 * Owned tables: organizations, teams, projects, users, memberships, api_tokens, mcp_clients, oauth_grants, element_proposals, idn_
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "identity" as const;

// Facade công khai của identity. Module khác (authoring, planning, ...) chỉ được
// import từ file này — không bao giờ với tay vào `./db/schema.js`.
export { projects } from "./db/schema.js";
export { APP_ROLE, appRole } from "./db/schema.js";
