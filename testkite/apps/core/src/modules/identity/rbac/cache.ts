/**
 * Permission cache, TTL 60s (blueprint §3). This is a cache PER PROCESS, not Redis:
 * the consequence is each API instance can drift up to 60s apart after a role change.
 * Acceptable because (a) HIGH actions bypass the cache entirely — see Task 6, and
 * (b) a role change calls invalidateTeam() right within the handling process — the real
 * call site is `identity/routes.ts::setMemberRole`, right after the UPDATE commits.
 *
 * The cache key is the SHA-256 hex of the secret (authenticator.ts), NOT the raw secret:
 * there is no path where a bearer token sits verbatim in process memory.
 *
 * Do NOT default `now` to Date.now in tests: the clock is injected so TTL tests don't
 * need to sleep.
 */
import type { CredentialKind } from "./authorize.js";
import type { MembershipRole, Permission } from "./permissions.js";

export const AUTHZ_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * The whole already-computed RequestContext, not just the role: the auth hook (Task 6)
 * must be able to rebuild the FULL context from a cache hit — otherwise a "cache hit"
 * would still have to touch the DB for userId/tokenId, and the 60s TTL would be
 * decorative.
 */
export type CachedGrant = {
  readonly teamId: string;
  readonly userId: string | null;
  readonly tokenId: string;
  readonly authKind: CredentialKind;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
  readonly cachedAt: number;
  /**
   * The CREDENTIAL's own deadline, copied from `api_tokens` at lookup time — not the cache's.
   * The 60s TTL bounds how stale a ROLE may be; it must never bound how long a credential
   * outlives its own expiry. Without this field, a token that expired one second after being
   * cached kept authenticating for the rest of the minute: the DB row said no, and nothing on
   * the cache-hit path ever asked it.
   *
   * EXPIRY IS THE ONLY HALF A SNAPSHOT CAN ANSWER, which is why it is the only one stored
   * here. It is a DEADLINE — already fixed in the row this entry was built from, so the wall
   * clock alone can decide it later. Revocation is an EVENT that happens AFTER that read:
   * the lookup filters `revoked_at IS NULL`, so a `revokedAt` copied alongside this field
   * would be `null` in every entry this cache ever holds, and a check on it would be dead
   * code dressed up as a guard. What actually bounds a revoked token: `invalidateTeam()`,
   * called by the revokeToken handler in the process that served the revocation, and the
   * 60s TTL everywhere else. Making revocation immediate ACROSS replicas needs a real
   * invalidation channel — that is M6's job, not this file's.
   */
  readonly expiresAt: Date;
};

export type AuthzCache = {
  get: (key: string) => CachedGrant | undefined;
  set: (key: string, grant: CachedGrant) => void;
  invalidateTeam: (teamId: string) => void;
  size: () => number;
};

export function createAuthzCache(opts: {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
} = {}): AuthzCache {
  const ttl = opts.ttlMs ?? AUTHZ_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const store = new Map<string, CachedGrant>();

  return {
    get(key) {
      const hit = store.get(key);
      if (hit === undefined) return undefined;
      // Two independent reasons to refuse, both terminal for this entry: the cache went
      // stale (TTL), or the credential's own deadline passed. The second is a property of
      // the CREDENTIAL, so it is checked against the wall clock, never against `cachedAt`.
      // Revocation is NOT checked here and cannot be — see `expiresAt` above.
      if (now() - hit.cachedAt > ttl || now() >= hit.expiresAt.getTime()) {
        store.delete(key);
        return undefined;
      }
      return hit;
    },
    set(key, grant) {
      // Map preserves insertion order ⇒ the oldest entry is the first key (FIFO, good enough for a 60s cache).
      // Only a key that is genuinely NEW can push the map past the cap: overwriting an
      // existing key leaves the size unchanged, so evicting for it would drop a live
      // entry for nothing (one busy token refreshing itself would keep forcing other
      // tokens back to the DB).
      if (!store.has(key) && store.size >= max) {
        const oldest = store.keys().next();
        if (!oldest.done) store.delete(oldest.value);
      }
      store.set(key, { ...grant, cachedAt: now() });
    },
    invalidateTeam(teamId) {
      for (const [k, v] of store) if (v.teamId === teamId) store.delete(k);
    },
    size: () => store.size,
  };
}
