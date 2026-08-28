/**
 * Ghi audit. Chỉ nhận `TkTx` (không nhận `TkDb`) — đúng khuôn `enqueueOutbox` của M1:
 * kiểu ép người gọi phải đang ở trong transaction của hành động, nên không tồn tại
 * "audit ma" (audit có mà hành động rollback) lẫn "hành động câm" (làm mà không ghi).
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
  if (event.action.trim().length === 0) throw new Error("audit: action không được rỗng");
  const meta = event.meta ?? {};
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > MAX_META_BYTES) {
    throw new Error(`audit: meta vượt ${MAX_META_BYTES} byte — audit không phải chỗ đổ log`);
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

/** SQL cho job hằng tháng (M6): đảm bảo có sẵn partition cho N tháng tới. */
export function ensureAuditPartitionsSql(monthsAhead: number): string {
  return `DO $$ DECLARE i int; BEGIN FOR i IN 0..${monthsAhead} LOOP
    PERFORM ensure_audit_partition((date_trunc('month', now()) + (i || ' months')::interval)::date);
  END LOOP; END $$;`;
}
