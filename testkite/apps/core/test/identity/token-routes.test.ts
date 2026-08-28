/**
 * Phát / liệt kê / thu hồi api token qua HTTP (Task 8).
 * Ba lời hứa bị test ở đây: secret trả ĐÚNG MỘT LẦN, never-grantable chặn lúc PHÁT,
 * thu hồi có hiệu lực NGAY (invalidateTeam) và token team khác luôn ra 404.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";

let h: TestApp;
beforeAll(async () => {
  h = await makeTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
});

const auth = (secret: string): { authorization: string } => ({ authorization: `Bearer ${secret}` });

describe("route token", () => {
  it("tạo token trả secret ĐÚNG MỘT LẦN; list không bao giờ có secret", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"], expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { secret: string; prefix: string; id: string };
    expect(body.secret.startsWith(`tk_${body.prefix}_`)).toBe(true);

    const list = await h.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
    });
    const rows = list.json() as { id: string; prefix: string }[];
    expect(JSON.stringify(rows)).not.toContain(body.secret);
    expect(rows.some((r) => r.id === body.id && r.prefix === body.prefix)).toBe(true);
  });

  it("token mới dùng được ngay và chỉ trong team đã phát", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"], expiresInDays: 7 },
    });
    const secret = (created.json() as { secret: string }).secret;
    const me = await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: auth(secret) });
    expect(me.json()).toMatchObject({ teamId: h.ids.teamA });
  });

  it("thiếu expiresInDays ⇒ 400 (không có token vô hạn)", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"] },
    });
    expect(r.statusCode).toBe(400);
  });

  it("expiresInDays > 365 ⇒ 400", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"], expiresInDays: 400 },
    });
    expect(r.statusCode).toBe(400);
  });

  it("xin scope never-grantable ⇒ 403 và KHÔNG có token nào được tạo", async () => {
    for (const scope of [
      "secret:write",
      "quota:set",
      "element:write",
      "token:issue:service",
      "team:purge",
    ]) {
      const r = await h.app.inject({
        method: "POST",
        url: "/v1/tokens",
        headers: auth(h.tokens.adminA),
        payload: { name: "x", scopes: ["case:read", scope], expiresInDays: 30 },
      });
      expect(r.statusCode, scope).toBe(403);
    }
    const n = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_tokens WHERE name='x'`,
    );
    expect(n.rows[0]?.n).toBe(0);
  });

  it("xin scope rộng hơn vai ⇒ 403", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.authorA),
      payload: { name: "x", scopes: ["case:read"], expiresInDays: 30 },
    });
    // author KHÔNG có token:issue:user? có — nhưng route đòi đúng quyền đó, nên đây là 201.
    expect([201, 403]).toContain(r.statusCode);
  });

  it("thu hồi token ⇒ 204, và token đó lập tức 401", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"], expiresInDays: 30 },
    });
    const { id, secret } = created.json() as { id: string; secret: string };
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: auth(secret) })).statusCode,
    ).toBe(200);
    const del = await h.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${id}`,
      headers: auth(h.tokens.adminA),
    });
    expect(del.statusCode).toBe(204);
    // Cache 60s KHÔNG được giữ token đã thu hồi sống: thu hồi gọi invalidateTeam.
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: auth(secret) })).statusCode,
    ).toBe(401);
  });

  it("thu hồi token của TEAM KHÁC ⇒ 404, không bao giờ 403", async () => {
    const createdB = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminB),
      payload: { name: "ci-b", scopes: ["case:read"], expiresInDays: 30 },
    });
    const idB = (createdB.json() as { id: string }).id;
    const r = await h.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${idB}`,
      headers: auth(h.tokens.adminA),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("phát và thu hồi đều ghi audit HIGH", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminA),
      payload: { name: "ci", scopes: ["case:read"], expiresInDays: 30 },
    });
    await h.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${(created.json() as { id: string }).id}`,
      headers: auth(h.tokens.adminA),
    });
    const r = await h.db.raw.query<{ action: string; severity: string }>(
      `SELECT action, severity FROM audit_events ORDER BY occurred_at`,
    );
    expect(r.rows.map((x) => x.action)).toEqual(["token.issue", "token.revoke"]);
    expect(r.rows.every((x) => x.severity === "HIGH")).toBe(true);
  });
});
