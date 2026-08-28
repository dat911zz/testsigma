import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expiryFromDays, hashTokenSecret, mintTokenSecret, parseTokenSecret, MAX_TOKEN_TTL_DAYS } from "./token.js";

describe("api token", () => {
  it("secret has the shape tk_<prefix>_<random> and the prefix round-trips", () => {
    const m = mintTokenSecret();
    expect(m.secret.startsWith(`tk_${m.prefix}_`)).toBe(true);
    expect(parseTokenSecret(m.secret)?.prefix).toBe(m.prefix);
    expect(m.prefix.length).toBe(8); // 4 hex bytes
  });

  it("two mints never collide", () => {
    const secrets = new Set(Array.from({ length: 200 }, () => mintTokenSecret().secret));
    expect(secrets.size).toBe(200);
  });

  it("tokenHash IS sha256(secret) — 32 raw bytes, not hex", () => {
    const m = mintTokenSecret();
    expect(m.tokenHash.length).toBe(32);
    expect(m.tokenHash.equals(createHash("sha256").update(m.secret).digest())).toBe(true);
    expect(hashTokenSecret(m.secret).equals(m.tokenHash)).toBe(true);
  });

  it("parsing a garbage string ⇒ null, does not throw", () => {
    for (const bad of ["", "tk_", "Bearer tk_a_b", "abc", "tk__x"]) {
      expect(parseTokenSecret(bad)).toBeNull();
    }
  });

  it("expiry is MANDATORY and is capped at 365 days", () => {
    const now = new Date("2026-08-28T00:00:00Z");
    expect(expiryFromDays(30, now).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(() => expiryFromDays(0, now)).toThrow();
    expect(() => expiryFromDays(-1, now)).toThrow();
    expect(() => expiryFromDays(MAX_TOKEN_TTL_DAYS + 1, now)).toThrow();
  });
});
