/**
 * Handler của identity. Descriptor nằm ở @testkite/contract (routes/identity.ts) —
 * file này chỉ nối nghiệp vụ vào hợp đồng đó.
 */
import { and, desc, eq } from "drizzle-orm";
import { identityRoutes, NotFoundError } from "@testkite/contract";
import { withTenant, type TkDb } from "../kernel/index.js";
import { publicRoute, route, type RouteRegistration } from "../../http/types.js";
import type { AuditPort } from "./audit-port.js";
import { issueApiToken, revokeApiToken } from "./auth/issue.js";
import { loginWithPassword, type DeferPort } from "./auth/login.js";
import { apiTokens, memberships, users } from "./db/schema.js";
import type { AuthzCache } from "./rbac/cache.js";

/**
 * `cache` là DEPENDENCY, không phải tuỳ chọn: đổi vai / thu hồi token mà không xoá
 * cache thì quyền vừa thu hồi còn hiệu lực tới hết TTL 60s trên mọi action
 * KHÔNG-HIGH (xem cache.ts).
 *
 * `audit` cũng vậy — nó là CỔNG (audit-port.ts) do tầng shell tiêm, vì bảng
 * audit_events thuộc governance, module cùng tầng DAG với identity.
 */
export type IdentityRouteDeps = {
  readonly db: TkDb;
  readonly audit: AuditPort;
  readonly cache: AuthzCache;
  readonly now?: () => Date;
  /** Xem `DeferPort`: audit của lần đăng nhập HỎNG chạy ngoài đường phản hồi. */
  readonly defer?: DeferPort;
};

const byId = (operationId: string): (typeof identityRoutes)[number] => {
  const d = identityRoutes.find((r) => r.operationId === operationId);
  if (d === undefined) throw new Error(`descriptor thiếu: ${operationId}`);
  return d;
};

export function identityRouteRegistrations(deps: IdentityRouteDeps): readonly RouteRegistration[] {
  const clock = deps.now ?? ((): Date => new Date());
  const loginDeps = {
    db: deps.db,
    audit: deps.audit,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.defer ? { defer: deps.defer } : {}),
  };

  return [
    publicRoute(byId("loginPassword"), async ({ body }) => {
      const r = await loginWithPassword(loginDeps, body);
      return {
        secret: r.secret,
        expiresAt: r.expiresAt.toISOString(),
        context: {
          userId: r.userId,
          teamId: r.teamId,
          role: r.role,
          scopes: [...r.scopes],
          authKind: "session",
        },
      };
    }),

    route(byId("getMe"), async ({ ctx }) => ({
      userId: ctx.userId,
      teamId: ctx.teamId,
      role: ctx.role,
      scopes: [...ctx.scopes],
      authKind: ctx.authKind === "session" ? "session" : "api_token",
    })),

    route(byId("listTokens"), async ({ ctx }) =>
      withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const rows = await tx
          .select({
            id: apiTokens.id,
            name: apiTokens.name,
            prefix: apiTokens.prefix,
            kind: apiTokens.kind,
            scopes: apiTokens.scopes,
            expiresAt: apiTokens.expiresAt,
            createdAt: apiTokens.createdAt,
            revokedAt: apiTokens.revokedAt,
            lastUsedAt: apiTokens.lastUsedAt,
          })
          .from(apiTokens)
          .orderBy(desc(apiTokens.createdAt));
        // Không có cột nào ở đây chạm token_hash: secret đã rời hệ thống lúc phát.
        return rows.map((r) => ({
          ...r,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          revokedAt: r.revokedAt?.toISOString() ?? null,
          lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        }));
      }),
    ),

    route(byId("createToken"), async ({ ctx, body }) => {
      const now = clock();
      return withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const minted = await issueApiToken(
          tx,
          { teamId: ctx.teamId },
          {
            name: body.name,
            scopes: body.scopes,
            expiresInDays: body.expiresInDays,
            kind: "user_pat",
            userId: ctx.userId,
            createdBy: ctx.userId,
          },
          now,
        );
        // Never-grantable ném ForbiddenError TRONG transaction ⇒ rollback ⇒ không có
        // token nào được tạo, cũng không có dòng audit nào nói dối là có.
        await deps.audit(tx, { teamId: ctx.teamId }, {
          actorKind: "token",
          actorId: ctx.userId,
          action: "token.issue",
          severity: "HIGH",
          targetKind: "api_token",
          targetId: minted.id,
          meta: { prefix: minted.prefix, scopes: [...body.scopes] },
        });
        return {
          id: minted.id,
          name: body.name,
          prefix: minted.prefix,
          kind: "user_pat",
          scopes: body.scopes,
          expiresAt: minted.expiresAt.toISOString(),
          createdAt: now.toISOString(),
          revokedAt: null,
          lastUsedAt: null,
          // Lần DUY NHẤT secret rời khỏi tiến trình. DB chỉ giữ sha256 của nó.
          secret: minted.secret,
        };
      });
    }),

    route(byId("revokeToken"), async ({ ctx, params }) => {
      const now = clock();
      await withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        // Token của team khác: RLS lọc mất ⇒ NotFoundError ⇒ 404, không bao giờ 403.
        await revokeApiToken(tx, { teamId: ctx.teamId }, params.tokenId, now);
        await deps.audit(tx, { teamId: ctx.teamId }, {
          actorKind: "token",
          actorId: ctx.userId,
          action: "token.revoke",
          severity: "HIGH",
          targetKind: "api_token",
          targetId: params.tokenId,
        });
      });
      // Token vừa thu hồi có thể đang nằm trong cache 60s ⇒ thổi cache của team ngay,
      // nếu không nó vẫn xác thực được tới một phút sau khi bị thu hồi.
      deps.cache.invalidateTeam(ctx.teamId);
      return {};
    }),

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

    route(byId("setMemberRole"), async ({ ctx, params, body }) => {
      const now = clock();
      const row = await withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        const updated = await tx
          .update(memberships)
          .set({ role: body.role })
          .where(and(eq(memberships.teamId, ctx.teamId), eq(memberships.userId, params.userId)))
          .returning({ userId: memberships.userId, role: memberships.role });
        const found = updated[0];
        // Không thấy row = hoặc không tồn tại, hoặc thuộc team khác (RLS đã lọc).
        // Cả hai đều trả 404 — không bao giờ 403 (blueprint §3 L3).
        if (found === undefined) throw new NotFoundError("member");
        await deps.audit(tx, { teamId: ctx.teamId }, {
          actorKind: "token",
          actorId: ctx.userId,
          action: "member.role_change",
          severity: "HIGH",
          targetKind: "membership",
          targetId: params.userId,
          meta: { role: found.role, at: now.toISOString() },
        });
        return found;
      });
      // SAU khi transaction commit (404 ném ở trên ⇒ rollback ⇒ không xoá nhầm):
      // quyền vừa đổi phải có hiệu lực NGAY, kể cả trên action KHÔNG-HIGH — chúng
      // đọc cache 60s, còn action HIGH thì đã luôn `fresh`. Đây chính là lời hứa
      // ghi ở đầu rbac/cache.ts; không có dòng này thì nó là lời hứa suông.
      deps.cache.invalidateTeam(ctx.teamId);
      return row;
    }),
  ];
}
