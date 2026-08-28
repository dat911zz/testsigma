/**
 * identity's handlers. The descriptor lives in @testkite/contract (routes/identity.ts) —
 * this file only wires business logic onto that contract.
 */
import { and, desc, eq } from "drizzle-orm";
import { identityRoutes, NotFoundError } from "@testkite/contract";
import { withTenant, type TkDb } from "../kernel/index.js";
import { publicRoute, route, type RouteRegistration } from "../../http/types.js";
import type { AuditPort } from "./audit-port.js";
import { issueApiToken, revokeApiToken } from "./auth/issue.js";
import { loginWithPassword, SESSION_TTL_DAYS, type DeferPort } from "./auth/login.js";
import { apiTokens, memberships, users } from "./db/schema.js";
import { createOidcConnector } from "./oidc/connector.js";
import { effectiveScopes } from "./rbac/authorize.js";
import type { AuthzCache } from "./rbac/cache.js";
import { ROLE_PERMISSIONS } from "./rbac/permissions.js";

/**
 * `cache` is a DEPENDENCY, not optional: changing a role / revoking a token without
 * clearing the cache leaves the just-revoked permission in effect until the 60s TTL runs
 * out on every NON-HIGH action (see cache.ts).
 *
 * `audit` is the same — it's a PORT (audit-port.ts) injected by the shell layer, because
 * the audit_events table belongs to governance, a module at the same DAG layer as identity.
 */
export type IdentityRouteDeps = {
  readonly db: TkDb;
  readonly audit: AuditPort;
  readonly cache: AuthzCache;
  readonly now?: () => Date;
  /** See `DeferPort`: audit for a FAILED login runs outside the response path. */
  readonly defer?: DeferPort;
};

const byId = (operationId: string): (typeof identityRoutes)[number] => {
  const d = identityRoutes.find((r) => r.operationId === operationId);
  if (d === undefined) throw new Error(`missing descriptor: ${operationId}`);
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
  const oidc = createOidcConnector({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) });

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

    // The oidcStart/oidcCallback descriptors are `auth: "public"` — they run BEFORE any
    // credential exists, so they must go through publicRoute() (route() throws immediately at app setup).
    publicRoute(byId("oidcStart"), async ({ params, body }) =>
      oidc.start({ connectorId: params.connectorId, redirectUri: body.redirectUri }),
    ),

    publicRoute(byId("oidcCallback"), async ({ params, body }) => {
      const now = clock();
      const identity = await oidc.callback({
        connectorId: params.connectorId,
        callbackUrl: body.callbackUrl,
      });
      return withTenant(deps.db, { teamId: identity.teamId }, async (tx) => {
        const scopes = effectiveScopes(identity.role, ROLE_PERMISSIONS[identity.role], "session");
        const minted = await issueApiToken(
          tx,
          { teamId: identity.teamId },
          {
            name: "session",
            scopes,
            expiresInDays: SESSION_TTL_DAYS,
            kind: "session",
            userId: identity.userId,
            createdBy: identity.userId,
          },
          now,
        );
        await deps.audit(tx, { teamId: identity.teamId }, {
          actorKind: "user",
          actorId: identity.userId,
          action: "auth.oidc_login",
          severity: "LOW",
          targetKind: "api_token",
          targetId: minted.id,
          meta: {
            subject: identity.subject,
            connectorId: params.connectorId,
            groups: identity.groups,
          },
        });
        return {
          secret: minted.secret,
          expiresAt: minted.expiresAt.toISOString(),
          context: {
            userId: identity.userId,
            teamId: identity.teamId,
            role: identity.role,
            scopes: [...scopes],
            authKind: "session",
          },
        };
      });
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
        // None of these columns touch token_hash: the secret already left the system at issue time.
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
        // never-grantable throws ForbiddenError INSIDE the transaction ⇒ rollback ⇒ no
        // token gets created, and no audit line lies about one existing.
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
          // The ONE time the secret leaves the process. The DB only ever keeps its sha256.
          secret: minted.secret,
        };
      });
    }),

    route(byId("revokeToken"), async ({ ctx, params }) => {
      const now = clock();
      await withTenant(deps.db, { teamId: ctx.teamId }, async (tx) => {
        // A token from another team: RLS filters it out ⇒ NotFoundError ⇒ 404, never 403.
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
      // The just-revoked token may still sit in the 60s cache ⇒ blow away the team's cache
      // right now, otherwise it would keep authenticating for up to a minute after revocation.
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
        // No row found = either it doesn't exist, or it belongs to another team (RLS filtered it).
        // Both cases return 404 — never 403 (blueprint §3 L3).
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
      // AFTER the transaction commits (a 404 thrown above ⇒ rollback ⇒ nothing wrongly
      // cleared): the just-changed permission must take effect IMMEDIATELY, even on
      // NON-HIGH actions — those read the 60s cache, while HIGH actions are always
      // `fresh` already. This is exactly the promise documented at the top of
      // rbac/cache.ts; without this line, that promise would be hollow.
      deps.cache.invalidateTeam(ctx.teamId);
      return row;
    }),
  ];
}
