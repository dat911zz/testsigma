/**
 * Writes an audit entry. Only takes a `TkTx` (never a `TkDb`) — the same mold as M1's
 * `enqueueOutbox`: the type forces the caller to already be inside the action's own
 * transaction, so there's no such thing as a "ghost audit" (an audit entry surviving an
 * action's rollback) or a "silent action" (something happens but nothing gets recorded).
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../../kernel/index.js";
import { auditEvents } from "../db/audit-schema.js";

export type AuditSeverity = "LOW" | "MEDIUM" | "HIGH";
export type AuditActorKind = "user" | "token" | "system";

export const AUDIT_RETENTION_DAYS = 400;
const MAX_META_BYTES = 8_192;

export type AuditEventInput = {
  readonly actorKind: AuditActorKind;
  readonly actorId: string | null;
  readonly action: string;
  readonly severity: AuditSeverity;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly meta?: Record<string, unknown>;
};

export async function writeAuditEvent(
  tx: TkTx,
  ctx: TenantContext,
  event: AuditEventInput,
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  if (event.action.trim().length === 0) throw new Error("audit: action must not be empty");
  const meta = event.meta ?? {};
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > MAX_META_BYTES) {
    throw new Error(`audit: meta exceeds ${MAX_META_BYTES} bytes — audit is not a log dump`);
  }
  await tx.insert(auditEvents).values({
    teamId,
    actorKind: event.actorKind,
    actorId: event.actorId,
    action: event.action,
    severity: event.severity,
    ...(event.targetKind !== undefined ? { targetKind: event.targetKind } : {}),
    ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    meta,
  });
}

/** SQL for the monthly job (M6): ensures a partition exists for the next N months. */
export function ensureAuditPartitionsSql(monthsAhead: number): string {
  return `DO $$ DECLARE i int; BEGIN FOR i IN 0..${monthsAhead} LOOP
    PERFORM ensure_audit_partition((date_trunc('month', now()) + (i || ' months')::interval)::date);
  END LOOP; END $$;`;
}
