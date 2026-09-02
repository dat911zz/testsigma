import { describe, expect, it } from "vitest";
import { AUTHZ_CACHE_TTL_MS, createAuthzCache } from "./cache.js";

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** 2100-01-01: far enough away that a test about the TTL is never also a test about expiry. */
const NEVER = new Date(4_102_444_800_000);

const grant = (teamId: string) =>
  ({
    teamId,
    userId: "u-1",
    tokenId: "tok-1",
    authKind: "user_pat" as const,
    role: "author" as const,
    scopes: ["case:read"] as const,
    cachedAt: 0,
    expiresAt: NEVER,
  });

describe("permission cache", () => {
  it("default TTL is exactly 60s per the blueprint", () => {
    expect(AUTHZ_CACHE_TTL_MS).toBe(60_000);
  });

  it("returns the value within the TTL", () => {
    const c = createAuthzCache({ now: () => 1000 });
    c.set("tok-1", grant("team-a"));
    expect(c.get("tok-1")?.role).toBe("author");
  });

  it("after 60s ⇒ miss (never returns stale data)", () => {
    const clock = fakeClock();
    const c = createAuthzCache({ now: clock.now });
    c.set("tok-1", grant("team-a"));
    clock.advance(59_999);
    expect(c.get("tok-1")).toBeDefined();
    clock.advance(2);
    expect(c.get("tok-1")).toBeUndefined();
  });

  it("an expired token is refused on a cache hit", () => {
    // The credential's OWN lifetime, not the cache's. A token minted with 5 seconds left
    // used to keep authenticating for the rest of the 60s TTL, because the only thing the
    // cache ever compared was `cachedAt`: the DB row said "expired", the cache never asked.
    const clock = fakeClock(1_000);
    const c = createAuthzCache({ now: clock.now });
    c.set("tok-1", { ...grant("team-a"), expiresAt: new Date(6_000) });
    expect(c.get("tok-1")).toBeDefined();
    clock.advance(4_999);
    expect(c.get("tok-1"), "one millisecond before expiry the token is still valid").toBeDefined();
    clock.advance(1);
    expect(c.get("tok-1"), "expires_at is reached ⇒ the entry is gone, TTL or not").toBeUndefined();
  });

  // There is deliberately NO "a revoked token is refused on a cache hit" test here. Such a
  // test can only be written by calling `set()` with a non-null revocation, a state the
  // production loader cannot produce (it filters `revoked_at IS NULL`), so it would be a
  // green test carrying the name of a hole that is still open. Revocation is bounded by
  // `invalidateTeam` in-process — covered end to end in test/identity/token-routes.test.ts
  // — and by the 60s TTL across replicas until M6 adds a real invalidation channel.

  it("invalidateTeam removes every entry for that team, keeps other teams", () => {
    const c = createAuthzCache({ now: () => 0 });
    c.set("tok-a1", grant("team-a"));
    c.set("tok-a2", grant("team-a"));
    c.set("tok-b1", grant("team-b"));
    c.invalidateTeam("team-a");
    expect(c.get("tok-a1")).toBeUndefined();
    expect(c.get("tok-a2")).toBeUndefined();
    expect(c.get("tok-b1")).toBeDefined();
  });

  it("has a size cap — the cache is not a place to leak memory", () => {
    const c = createAuthzCache({ now: () => 0, maxEntries: 10 });
    for (let i = 0; i < 50; i += 1) c.set(`tok-${i}`, grant("team-a"));
    expect(c.size()).toBeLessThanOrEqual(10);
  });

  it("refreshing an EXISTING key while full evicts nobody — the cap counts keys, not writes", () => {
    // Overwriting a key that is already stored adds no entry, so evicting the oldest one
    // would be pure loss: a single busy token re-authenticating every 60s would keep
    // pushing other tokens back to the DB even though the map never grew.
    const c = createAuthzCache({ now: () => 0, maxEntries: 3 });
    for (const k of ["tok-a", "tok-b", "tok-c"]) c.set(k, grant("team-a"));
    c.set("tok-c", grant("team-a"));
    expect(c.size()).toBe(3);
    expect(c.get("tok-a"), "the oldest entry was evicted by a plain overwrite").toBeDefined();
  });

  it("a NEW key while full still evicts the oldest one", () => {
    const c = createAuthzCache({ now: () => 0, maxEntries: 3 });
    for (const k of ["tok-a", "tok-b", "tok-c"]) c.set(k, grant("team-a"));
    c.set("tok-d", grant("team-a"));
    expect(c.size()).toBe(3);
    expect(c.get("tok-a")).toBeUndefined();
    expect(c.get("tok-d")).toBeDefined();
  });
});
