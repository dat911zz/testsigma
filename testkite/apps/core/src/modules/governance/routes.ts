/**
 * Governance's handler. The `listAuditEvents` descriptor lives in
 * `@testkite/contract` (routes/identity.ts) because that's the contract file for the /v1
 * surface owned by identity; the handler lives HERE because the `audit_events` **table**
 * belongs to governance (ownership.json). No contradiction: the descriptor is about HTTP, ownership is about the table.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { identityRoutes } from "@testkite/contract";
import { withTenant, type TkDb } from "../kernel/index.js";
import { route, type RouteRegistration } from "../../http/types.js";
import { auditEvents } from "./db/audit-schema.js";

export function governanceRouteRegistrations(deps: {
  readonly db: TkDb;
}): readonly RouteRegistration[] {
  const descriptor = identityRoutes.find((r) => r.operationId === "listAuditEvents");
  if (descriptor === undefined) throw new Error("missing descriptor: listAuditEvents");
  return [
    route(descriptor, async ({ ctx, query }) =>
      withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        // The tenant predicate leads, and is never optional: RLS enforces it too, but a
        // read of an append-only log fails SILENTLY in the wrong direction — nobody
        // notices rows they should not have seen. It also matches the shape of the
        // `(team_id, occurred_at DESC)` index this query is meant to use.
        const conds = [
          eq(auditEvents.teamId, ctx.teamId),
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
          // No empty-list branch any more: the tenant predicate is always present, so
          // `where()` can never be reached with nothing to filter on.
          .where(and(...conds))
          .orderBy(desc(auditEvents.occurredAt))
          .limit(query.limit);
        return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
      }),
    ),
  ];
}
