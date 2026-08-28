/**
 * Security invariant of the authenticator: the RAW secret must not exist anywhere except
 * the exact parameter variable. The DB stores SHA-256 (token.ts) — the in-memory cache must
 * also be keyed by SHA-256, otherwise the user's real bearer token sits verbatim in the
 * heap for the whole 60s TTL (readable via heap dump, snapshot, APM).
 *
 * This test runs entirely on the CACHE HIT path, so it needs no DB: db is replaced with a
 * proxy that throws the instant it's touched.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TkDb } from "../../kernel/index.js";
import type { AuthzCache, CachedGrant } from "../rbac/cache.js";
import { createAuthenticator } from "./authenticator.js";
import { mintTokenSecret } from "./token.js";

/** Touching the db in this test = a bug: a cache hit must never round-trip to the DB. */
const dbNeverUsed = new Proxy(
  {},
  {
    get(_target, prop): never {
      throw new Error(`authenticate() touched the DB (.${String(prop)}) despite a cache hit`);
    },
  },
) as unknown as TkDb;

const GRANT: CachedGrant = {
  teamId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  tokenId: "33333333-3333-4333-8333-333333333333",
  authKind: "user_pat",
  role: "author",
  scopes: ["case:read"],
  cachedAt: 0,
};

function recordingCache(): { cache: AuthzCache; gets: string[] } {
  const gets: string[] = [];
  const cache: AuthzCache = {
    get(key) {
      gets.push(key);
      return GRANT;
    },
    set() {
      /* unused on the cache-hit path */
    },
    invalidateTeam() {
      /* unused on the cache-hit path */
    },
    size: () => 1,
  };
  return { cache, gets };
}

describe("authenticator — permission cache key", () => {
  it("key is the SHA-256 hex of the secret, NEVER the raw secret", async () => {
    const minted = mintTokenSecret();
    const { cache, gets } = recordingCache();
    const authenticator = createAuthenticator({ db: dbNeverUsed, cache });

    const principal = await authenticator.authenticate(minted.secret, { fresh: false });

    expect(principal).toMatchObject({ teamId: GRANT.teamId, role: "author" });
    expect(gets).toEqual([createHash("sha256").update(minted.secret).digest("hex")]);
    expect(gets).not.toContain(minted.secret);
  });

  it("secret with the wrong format: touches neither cache nor DB", async () => {
    const { cache, gets } = recordingCache();
    const authenticator = createAuthenticator({ db: dbNeverUsed, cache });

    expect(await authenticator.authenticate("not-a-token", { fresh: false })).toBeNull();
    expect(gets).toEqual([]);
  });
});
