import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";

let h: TestApp;
beforeAll(async () => { h = await makeTestApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.seed(); });

describe("hook xác thực", () => {
  it("route public không cần credential", async () => {
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("thiếu Authorization ⇒ 401 UNAUTHORIZED", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("token bịa / sai định dạng / đúng định dạng nhưng không có trong DB ⇒ 401", async () => {
    for (const bad of ["Bearer abc", "Bearer tk_00000000_khong-ton-tai-nhung-du-dai-hon-20", "Token x", ""]) {
      const r = await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: bad } });
      expect(r.statusCode, bad).toBe(401);
    }
  });

  it("token hợp lệ ⇒ 200 và context có teamId lấy từ TOKEN, không từ client", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ teamId: h.ids.teamA, role: "author", authKind: "api_token" });
  });

  it("scope hiệu lực trong /me = token ∩ role (token xin member:manage bị cắt)", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorAOverreach}` },
    });
    const body = r.json() as { scopes: string[] };
    expect(body.scopes).toContain("case:read");
    expect(body.scopes).not.toContain("member:manage");
  });

  it("token hết hạn ⇒ 401", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.expiredA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("token đã thu hồi ⇒ 401", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.revokedA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("thiếu permission của route ⇒ 403 (trong chính team của mình)", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/members",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("đủ permission ⇒ 200", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/members",
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it("cache 60s: lần thứ hai không đọc lại DB", async () => {
    h.counters.reset();
    await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${h.tokens.authorA}` } });
    const first = h.counters.authLookups;
    await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${h.tokens.authorA}` } });
    expect(first).toBe(1);
    expect(h.counters.authLookups).toBe(1);
  });

  it("action HIGH BỎ QUA cache — luôn đọc lại DB", async () => {
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    h.counters.reset();
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    expect(h.counters.authLookups).toBe(2);
  });

  it("hạ vai giữa chừng: action HIGH thấy ngay, không chờ hết TTL", async () => {
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    await h.demoteAdminToViewer();
    const r = await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    expect(r.statusCode).toBe(403);
  });

  it("token của team B KHÔNG bao giờ nhìn thấy dữ liệu team A", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.adminB}` },
    });
    expect(r.json()).toMatchObject({ teamId: h.ids.teamB });
  });

  it("mọi phản hồi mang requestId để lần vết log", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect((r.json() as { requestId: string }).requestId.length).toBeGreaterThan(0);
  });
});
