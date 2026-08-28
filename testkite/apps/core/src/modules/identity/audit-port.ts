/**
 * CỔNG ghi audit — lý do tồn tại là DAG, không phải thẩm mỹ.
 *
 * `identity` và `governance` NẰM CÙNG TẦNG (module-dag.json: cả hai chỉ được import
 * `kernel`). Bảng `audit_events` thuộc governance, nhưng chính identity là nơi sinh ra
 * những sự kiện phải ghi audit (đăng nhập, phát/thu hồi token, đổi vai). Import
 * `governance/index.js` từ đây là cạnh NGANG — eslint-boundaries chặn, và đúng ra phải
 * chặn: nó biến hai module cùng tầng thành một khối dính.
 *
 * Vì vậy identity chỉ khai KIỂU của việc "ghi một dòng audit"; TẦNG SHELL
 * (composition-root / test harness — nơi được phép biết cả hai module) tiêm
 * `writeAuditEvent` thật của governance vào. Kiểu ở đây khớp CẤU TRÚC với
 * `AuditEventInput` của governance, nên phép tiêm là type-safe mà không có import nào.
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
 * Nhận `TkTx` chứ không `TkDb`: audit phải nằm TRONG chính transaction của hành động
 * (khuôn của `enqueueOutbox`/`writeAuditEvent`) — không có "audit ma" khi hành động
 * rollback, cũng không có "hành động câm" khi audit hỏng.
 */
export type AuditPort = (tx: TkTx, ctx: TenantContext, event: AuditEvent) => Promise<void>;
