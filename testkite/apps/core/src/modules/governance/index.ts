/**
 * Module: governance
 * Owned tables: quota_limits, gov_, usage_counters, usage_ledger, audit_events
 *
 * Rules (docs/SYSTEM_DESIGN.md §4):
 *  - FORWARD calls along the DAG = import the facade (this file). BACKWARD/SIDEWAYS calls = domain event via transactional outbox.
 *  - No other module may touch this module's tables (enforced by ownership.json + eslint-boundaries).
 *  - Repositories must be constructed with TenantContext (fail-closed) — see isolation layer L1.
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
export { quotaLimits } from "./db/schema.js";
export { seedQuotaDefaults } from "./onboarding.js";
export { usageCounters } from "./db/usage-schema.js";
export {
  reserveRunSlot,
  refundRunSlot,
  QUOTA_METRIC_RUNS_PER_DAY,
  type ReserveResult,
} from "./quota.js";
