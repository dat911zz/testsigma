import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, passwordPolicy, verifyPassword } from "./password.js";

describe("password hashing (argon2id)", () => {
  it("produces an argon2id PHC string with the correct OWASP parameters", async () => {
    const h = await hashPassword("use-a-long-password");
    expect(h.startsWith("$argon2id$v=19$")).toBe(true);
    expect(h).toContain("m=19456");
    expect(h).toContain("t=2");
    expect(h).toContain("p=1");
  });

  it("hashing the same password twice produces two different strings (random salt)", async () => {
    const [a, b] = await Promise.all([hashPassword("a-longer-password-12"), hashPassword("a-longer-password-12")]);
    expect(a).not.toBe(b);
  });

  it("verify with the right password ⇒ true, wrong ⇒ false", async () => {
    const h = await hashPassword("a-longer-password-12");
    expect(await verifyPassword(h, "a-longer-password-12")).toBe(true);
    expect(await verifyPassword(h, "a-longer-password-13")).toBe(false);
  });

  it("garbage hash ⇒ false, does NOT throw (login must not 500 on dirty data)", async () => {
    expect(await verifyPassword("not-a-phc-string", "x")).toBe(false);
    expect(await verifyPassword("", "x")).toBe(false);
  });

  it("needsRehash catches an old hash with low parameters", async () => {
    expect(needsRehash(await hashPassword("a-longer-password-12"))).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
  });

  it("password policy: minimum 12 characters, blocks overly common passwords", () => {
    expect(passwordPolicy("short").ok).toBe(false);
    expect(passwordPolicy("password1234").ok).toBe(false);
    expect(passwordPolicy("use-a-long-password").ok).toBe(true);
  });
});
