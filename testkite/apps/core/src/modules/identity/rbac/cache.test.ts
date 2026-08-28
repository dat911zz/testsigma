import { describe, expect, it } from "vitest";
import { AUTHZ_CACHE_TTL_MS, createAuthzCache } from "./cache.js";

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const grant = (teamId: string) =>
  ({
    teamId,
    userId: "u-1",
    tokenId: "tok-1",
    authKind: "user_pat" as const,
    role: "author" as const,
    scopes: ["case:read"] as const,
    cachedAt: 0,
  });

describe("cache quyền", () => {
  it("TTL mặc định đúng 60s như blueprint", () => {
    expect(AUTHZ_CACHE_TTL_MS).toBe(60_000);
  });

  it("trả lại giá trị trong TTL", () => {
    const c = createAuthzCache({ now: () => 1000 });
    c.set("tok-1", grant("team-a"));
    expect(c.get("tok-1")?.role).toBe("author");
  });

  it("hết 60s ⇒ miss (không trả dữ liệu ôi)", () => {
    const clock = fakeClock();
    const c = createAuthzCache({ now: clock.now });
    c.set("tok-1", grant("team-a"));
    clock.advance(59_999);
    expect(c.get("tok-1")).toBeDefined();
    clock.advance(2);
    expect(c.get("tok-1")).toBeUndefined();
  });

  it("invalidateTeam xoá mọi entry của team đó, giữ team khác", () => {
    const c = createAuthzCache({ now: () => 0 });
    c.set("tok-a1", grant("team-a"));
    c.set("tok-a2", grant("team-a"));
    c.set("tok-b1", grant("team-b"));
    c.invalidateTeam("team-a");
    expect(c.get("tok-a1")).toBeUndefined();
    expect(c.get("tok-a2")).toBeUndefined();
    expect(c.get("tok-b1")).toBeDefined();
  });

  it("có trần kích thước — cache không phải chỗ rò bộ nhớ", () => {
    const c = createAuthzCache({ now: () => 0, maxEntries: 10 });
    for (let i = 0; i < 50; i += 1) c.set(`tok-${i}`, grant("team-a"));
    expect(c.size()).toBeLessThanOrEqual(10);
  });
});
