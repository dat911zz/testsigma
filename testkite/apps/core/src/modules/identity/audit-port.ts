/**
 * Audit-write PORT — this exists because of the DAG, not for aesthetics.
 *
 * `identity` and `governance` sit at THE SAME LAYER (module-dag.json: both may only import
 * `kernel`). The `audit_events` table belongs to governance, but identity is where the
 * events that must be audited originate (login, token issue/revoke, role change). Importing
 * `governance/index.js` from here would be a SIDEWAYS edge — eslint-boundaries blocks it,
 * and rightly so: it would fuse two same-layer modules into one solid block.
 *
 * So identity only declares the TYPE of "write one audit line"; the SHELL LAYER
 * (composition-root / test harness — the only place allowed to know about both modules)
 * injects governance's real `writeAuditEvent`. The type here STRUCTURALLY matches
 * governance's `AuditEventInput`, so the injection is type-safe with no import at all.
 */
import type { TenantContext, TkTx } from "../kernel/index.js";

export type AuditEventSeverity = "LOW" | "MEDIUM" | "HIGH";
export type AuditEventActorKind = "user" | "token" | "system";

export type AuditEvent = {
  readonly actorKind: AuditEventActorKind;
  readonly actorId: string | null;
  readonly action: string;
  readonly severity: AuditEventSeverity;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly meta?: Record<string, unknown>;
};

/**
 * Takes `TkTx`, not `TkDb`: the audit write must happen INSIDE the same transaction as the
 * action (the shape of `enqueueOutbox`/`writeAuditEvent`) — no "ghost audit" when the action
 * rolls back, and no "silent action" when the audit write fails.
 */
export type AuditPort = (tx: TkTx, ctx: TenantContext, event: AuditEvent) => Promise<void>;
