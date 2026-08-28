/**
 * Tra credential → RequestContext. Hai pha, đúng như spike 2026-08-28 chỉ ra:
 *   pha 1 (role testkite_auth, KHÔNG tenant ctx): tìm token theo sha256 + membership
 *   pha 2 (mọi thứ sau đó): withTenant(teamId) như phần còn lại của hệ
 *
 * `fresh: true` (action HIGH) bỏ qua cache hoàn toàn — hạ vai một người phải có
 * hiệu lực NGAY trên các action nhạy cảm, không chờ hết TTL 60s.
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
  /** Hook đếm số lần thật sự chạm DB — test cache dùng nó. */
  readonly onLookup?: () => void;
};

export function createAuthenticator(deps: AuthenticatorDeps): Authenticator {
  const now = deps.now ?? ((): Date => new Date());

  return {
    async authenticate(rawSecret, opts) {
      // Sai định dạng thì không tốn một round-trip DB nào.
      if (parseTokenSecret(rawSecret) === null) return null;
      // Key cache là SHA-256, KHÔNG phải secret thô: bearer token thật không được
      // nằm nguyên văn trong heap suốt TTL 60s (heap dump/APM đọc được). Cùng đúng
      // giá trị DB lưu ở token_hash, và chỉ tốn một phép hash CPU (0,0026ms) —
      // không thêm round-trip nào so với việc dùng chuỗi thô.
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

        // Token gắn user ⇒ vai lấy từ membership; token service (userId null) ⇒ vai 'runner'.
        if (tok.userId === null) return { tok, role: "runner" as MembershipRole };
        const mem = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.teamId, tok.teamId), eq(memberships.userId, tok.userId)))
          .limit(1);
        const role = mem[0]?.role;
        // Người đã bị gỡ khỏi team: token còn nhưng không còn vai ⇒ coi như không hợp lệ.
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
      });
      // last_used_at cập nhật bằng UPDATE rời (không nằm trong hot path xác thực):
      // đường auth chỉ có quyền SELECT, nên việc ghi thuộc về withTenant ở tầng route.
      return principal;
    },
  };
}
