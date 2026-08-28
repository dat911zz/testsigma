import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expiryFromDays, hashTokenSecret, mintTokenSecret, parseTokenSecret, MAX_TOKEN_TTL_DAYS } from "./token.js";

describe("api token", () => {
  it("secret có dạng tk_<prefix>_<random> và prefix trích lại được", () => {
    const m = mintTokenSecret();
    expect(m.secret.startsWith(`tk_${m.prefix}_`)).toBe(true);
    expect(parseTokenSecret(m.secret)?.prefix).toBe(m.prefix);
    expect(m.prefix.length).toBe(8); // 4 byte hex
  });

  it("hai lần mint không bao giờ trùng", () => {
    const secrets = new Set(Array.from({ length: 200 }, () => mintTokenSecret().secret));
    expect(secrets.size).toBe(200);
  });

  it("tokenHash CHÍNH LÀ sha256(secret) — 32 byte raw, không phải hex", () => {
    const m = mintTokenSecret();
    expect(m.tokenHash.length).toBe(32);
    expect(m.tokenHash.equals(createHash("sha256").update(m.secret).digest())).toBe(true);
    expect(hashTokenSecret(m.secret).equals(m.tokenHash)).toBe(true);
  });

  it("parse chuỗi rác ⇒ null, không ném", () => {
    for (const bad of ["", "tk_", "Bearer tk_a_b", "abc", "tk__x"]) {
      expect(parseTokenSecret(bad)).toBeNull();
    }
  });

  it("hạn dùng BẮT BUỘC và bị chặn trên 365 ngày", () => {
    const now = new Date("2026-08-28T00:00:00Z");
    expect(expiryFromDays(30, now).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(() => expiryFromDays(0, now)).toThrow();
    expect(() => expiryFromDays(-1, now)).toThrow();
    expect(() => expiryFromDays(MAX_TOKEN_TTL_DAYS + 1, now)).toThrow();
  });
});
