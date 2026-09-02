/**
 * Look up credential → RequestContext. Two phases, exactly as the 2026-08-28 spike found:
 *   phase 1 (role testkite_auth, NO tenant ctx): find the token by sha256 + membership
 *   phase 2 (everything after): withTenant(teamId) like the rest of the system
 *
 * `fresh: true` (HIGH action) bypasses the cache entirely — demoting someone must take
 * effect IMMEDIATELY on sensitive actions, without waiting out the 60s TTL.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { withAuthRole, type TkDb } from "../../kernel/index.js";
import { apiTokens, memberships } from "../db/schema.js";
import { effectiveScopes, type CredentialKind } from "../rbac/authorize.js";
import type { AuthzCache } from "../rbac/cache.js";
import type { MembershipRole, Permission } from "../rbac/permissions.js";
import { hashTokenSecret, parseTokenSecret } from "./token.js";

export type AuthenticatedPrincipal = {
  readonly teamId: string;
  readonly userId: string | null;
  readonly tokenId: string;
  readonly authKind: CredentialKind;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
};

export type Authenticator = {
  authenticate: (
    rawSecret: string,
    opts: { readonly fresh: boolean },
  ) => Promise<AuthenticatedPrincipal | null>;
};

export type AuthenticatorDeps = {
  readonly db: TkDb;
  readonly cache: AuthzCache;
  readonly now?: () => Date;
  /** Hook counting how many times the DB was actually touched — cache tests use this. */
  readonly onLookup?: () => void;
};

export function createAuthenticator(deps: AuthenticatorDeps): Authenticator {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async authenticate(rawSecret, opts) {
      // Wrong format costs zero DB round-trips.
      if (parseTokenSecret(rawSecret) === null) return null;
      // Cache key is SHA-256, NOT the raw secret: the user's real bearer token must not
      // sit verbatim in the heap for the whole 60s TTL (heap dumps/APM can read it). This
      // matches the exact value the DB stores in token_hash, and costs only one CPU hash
      // (0.0026ms) — no extra round-trip compared to using the raw string.
      const tokenHash = hashTokenSecret(rawSecret);
      const cacheKey = tokenHash.toString("hex");

      if (!opts.fresh) {
        const hit = deps.cache.get(cacheKey);
        if (hit !== undefined) {
          return {
            teamId: hit.teamId,
            userId: hit.userId,
            tokenId: hit.tokenId,
            authKind: hit.authKind,
            role: hit.role,
            scopes: hit.scopes,
          };
        }
      }

      deps.onLookup?.();
      const found = await withAuthRole(deps.db, async (tx) => {
        const rows = await tx
          .select({
            id: apiTokens.id,
            teamId: apiTokens.teamId,
            userId: apiTokens.userId,
            kind: apiTokens.kind,
            scopes: apiTokens.scopes,
            // Selected even though the WHERE clause below already filters on it: this is
            // what the cache stores so that a hit can tell on its own when the credential's
            // deadline passes, without a round-trip. `revoked_at` is deliberately NOT
            // selected — the same WHERE pins it to `null`, so caching it would cache a
            // constant (see rbac/cache.ts::CachedGrant.expiresAt).
            expiresAt: apiTokens.expiresAt,
          })
          .from(apiTokens)
          .where(
            and(
              eq(apiTokens.tokenHash, tokenHash),
              isNull(apiTokens.revokedAt),
              gt(apiTokens.expiresAt, now()),
            ),
          )
          .limit(1);
        const tok = rows[0];
        if (tok === undefined) return null;

        // Token tied to a user ⇒ role comes from membership; service token (userId null) ⇒ role 'runner'.
        if (tok.userId === null) return { tok, role: "runner" as MembershipRole };
        const mem = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.teamId, tok.teamId), eq(memberships.userId, tok.userId)))
          .limit(1);
        const role = mem[0]?.role;
        // Person was removed from the team: token still exists but has no role ⇒ treat as invalid.
        if (role === undefined) return null;
        return { tok, role };
      });

      if (found === null) return null;
      const kind: CredentialKind = found.tok.kind;
      const principal: AuthenticatedPrincipal = {
        teamId: found.tok.teamId,
        userId: found.tok.userId,
        tokenId: found.tok.id,
        authKind: kind,
        role: found.role,
        scopes: effectiveScopes(found.role, found.tok.scopes, kind),
      };
      deps.cache.set(cacheKey, {
        teamId: principal.teamId,
        userId: principal.userId,
        tokenId: principal.tokenId,
        authKind: principal.authKind,
        role: principal.role,
        scopes: principal.scopes,
        cachedAt: 0,
        expiresAt: found.tok.expiresAt,
      });
      // last_used_at is updated by a separate UPDATE (not on the auth hot path):
      // the auth path only has SELECT privileges, so writing belongs to withTenant at the route layer.
      return principal;
    },
  };
}
