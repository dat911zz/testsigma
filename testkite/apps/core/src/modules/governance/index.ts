/**
 * Module: governance
 * Owned tables: quota_limits, gov_, usage_counters, usage_ledger, audit_events
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "governance" as const;

export {
  writeAuditEvent,
  AUDIT_RETENTION_DAYS,
  ensureAuditPartitionsSql,
  type AuditEventInput,
  type AuditSeverity,
  type AuditActorKind,
} from "./audit/write.js";
export { auditEvents } from "./db/audit-schema.js";
