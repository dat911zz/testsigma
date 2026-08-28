/**
 * Module: kernel
 * Owned tables: krn_ (outbox, migrations), sec_ (secrets envelope-encrypted)
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "kernel" as const;

// Facade công khai của kernel. Module khác chỉ được import từ file này —
// không bao giờ với tay vào `./db/*.js`.
export { withTenant, withAuthRole } from "./db/tenant.js";
// Role DB do kernel sở hữu. Module xuôi DAG (identity, authoring, ...) gắn RLS policy
// bằng `appRole` lấy từ ĐÂY — không định nghĩa lại pgRole cùng tên ở module của mình.
export { APP_ROLE, appRole, AUTH_ROLE, authRole, RELAY_ROLE, relayRole } from "./db/schema.js";
export { MissingTenantContextError, TenantRepo, assertTenantContext } from "./db/repo.js";
export { createDb, type DbHandle } from "./db/client.js";
export type { TenantContext, TkDb, TkTx } from "./db/types.js";
export { loadEnv, parseEnv, envSchema, type KernelEnv } from "./env.js";
export { enqueueOutbox, type OutboxEvent } from "./outbox/writer.js";
export {
  runRelayOnce,
  type OutboxRecord,
  type Publisher,
  type RelayOptions,
  type RelayResult,
} from "./outbox/relay.js";
