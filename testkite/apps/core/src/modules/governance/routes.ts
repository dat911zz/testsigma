/**
 * Handler của governance. Descriptor `listAuditEvents` sống trong
 * `@testkite/contract` (routes/identity.ts) vì đó là file hợp đồng của bề mặt /v1 do
 * identity sở hữu; handler nằm ở ĐÂY vì **bảng** `audit_events` thuộc governance
 * (ownership.json). Không mâu thuẫn: descriptor nói về HTTP, ownership nói về bảng.
 */
import { and, desc, gte, lte } from "drizzle-orm";
import { identityRoutes } from "@testkite/contract";
import { withTenant, type TkDb } from "../kernel/index.js";
import { route, type RouteRegistration } from "../../http/types.js";
import { auditEvents } from "./db/audit-schema.js";

export function governanceRouteRegistrations(deps: {
  readonly db: TkDb;
}): readonly RouteRegistration[] {
  const descriptor = identityRoutes.find((r) => r.operationId === "listAuditEvents");
  if (descriptor === undefined) throw new Error("descriptor thiếu: listAuditEvents");
  return [
    route(descriptor, async ({ ctx, query }) =>
      withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const conds = [
          ...(query.since !== undefined ? [gte(auditEvents.occurredAt, new Date(query.since))] : []),
          ...(query.until !== undefined ? [lte(auditEvents.occurredAt, new Date(query.until))] : []),
        ];
        const rows = await tx
          .select({
            id: auditEvents.id,
            occurredAt: auditEvents.occurredAt,
            actorKind: auditEvents.actorKind,
            actorId: auditEvents.actorId,
            action: auditEvents.action,
            severity: auditEvents.severity,
            targetKind: auditEvents.targetKind,
            targetId: auditEvents.targetId,
          })
          .from(auditEvents)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(auditEvents.occurredAt))
          .limit(query.limit);
        return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
      }),
    ),
  ];
}
