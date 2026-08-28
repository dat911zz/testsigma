import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, passwordPolicy, verifyPassword } from "./password.js";

describe("hash mật khẩu (argon2id)", () => {
  it("sinh chuỗi PHC argon2id với đúng tham số OWASP", async () => {
    const h = await hashPassword("dung-mot-mat-khau-dai");
    expect(h.startsWith("$argon2id$v=19$")).toBe(true);
    expect(h).toContain("m=19456");
    expect(h).toContain("t=2");
    expect(h).toContain("p=1");
  });

  it("hai lần hash cùng mật khẩu ra hai chuỗi khác nhau (salt ngẫu nhiên)", async () => {
    const [a, b] = await Promise.all([hashPassword("mat-khau-dai-hon-12"), hashPassword("mat-khau-dai-hon-12")]);
    expect(a).not.toBe(b);
  });

  it("verify đúng mật khẩu ⇒ true, sai ⇒ false", async () => {
    const h = await hashPassword("mat-khau-dai-hon-12");
    expect(await verifyPassword(h, "mat-khau-dai-hon-12")).toBe(true);
    expect(await verifyPassword(h, "mat-khau-dai-hon-13")).toBe(false);
  });

  it("hash rác ⇒ false, KHÔNG ném (login không được 500 vì dữ liệu bẩn)", async () => {
    expect(await verifyPassword("khong-phai-phc", "x")).toBe(false);
    expect(await verifyPassword("", "x")).toBe(false);
  });

  it("needsRehash bắt được hash cũ tham số thấp", async () => {
    expect(needsRehash(await hashPassword("mat-khau-dai-hon-12"))).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(needsRehash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
  });

  it("chính sách mật khẩu: tối thiểu 12 ký tự, chặn mật khẩu quá phổ biến", () => {
    expect(passwordPolicy("ngan").ok).toBe(false);
    expect(passwordPolicy("password1234").ok).toBe(false);
    expect(passwordPolicy("dung-mot-mat-khau-dai").ok).toBe(true);
  });
});
