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
      if (now() - hit.cachedAt > ttl) {
        store.delete(key);
        return undefined;
      }
      return hit;
    },
    set(key, grant) {
      // Map preserves insertion order ⇒ the oldest entry is the first key (FIFO, good enough for a 60s cache).
      if (store.size >= max) {
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
