/**
 * Handler của identity. Descriptor nằm ở @testkite/contract (routes/identity.ts) —
 * file này chỉ nối nghiệp vụ vào hợp đồng đó.
 */
import { and, eq } from "drizzle-orm";
import { identityRoutes, NotFoundError } from "@testkite/contract";
import { withTenant, type TkDb } from "../kernel/index.js";
import { route, type RouteRegistration } from "../../http/types.js";
import { memberships, users } from "./db/schema.js";

export type IdentityRouteDeps = { readonly db: TkDb };

const byId = (operationId: string): (typeof identityRoutes)[number] => {
  const d = identityRoutes.find((r) => r.operationId === operationId);
  if (d === undefined) throw new Error(`descriptor thiếu: ${operationId}`);
  return d;
};

export function identityRouteRegistrations(deps: IdentityRouteDeps): readonly RouteRegistration[] {
  return [
    route(byId("getMe"), async ({ ctx }) => ({
      userId: ctx.userId,
      teamId: ctx.teamId,
      role: ctx.role,
      scopes: [...ctx.scopes],
      authKind: ctx.authKind === "session" ? "session" : "api_token",
    })),

    route(byId("listMembers"), async ({ ctx }) =>
      withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const rows = await tx
          .select({ userId: memberships.userId, email: users.email, role: memberships.role })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.teamId, ctx.teamId));
        return rows;
      }),
    ),

    route(byId("setMemberRole"), async ({ ctx, params, body }) =>
      withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const updated = await tx
          .update(memberships)
          .set({ role: body.role })
          .where(and(eq(memberships.teamId, ctx.teamId), eq(memberships.userId, params.userId)))
          .returning({ userId: memberships.userId, role: memberships.role });
        const row = updated[0];
        // Không thấy row = hoặc không tồn tại, hoặc thuộc team khác (RLS đã lọc).
        // Cả hai đều trả 404 — không bao giờ 403 (blueprint §3 L3).
        if (row === undefined) throw new NotFoundError("member");
        return row;
      }),
    ),
  ];
}
