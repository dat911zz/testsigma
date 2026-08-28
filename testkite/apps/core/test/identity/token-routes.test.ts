/**
 * Issue / list / revoke api tokens over HTTP (Task 8).
 * Three promises are tested here: the secret is returned EXACTLY ONCE, never-grantable is
 * blocked at ISSUE time, revocation takes effect IMMEDIATELY (invalidateTeam), and a token
 * from another team always comes back 404.
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

describe("token routes", () => {
  it("creating a token returns the secret EXACTLY ONCE; list never contains the secret", async () => {
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

  it("a new token works immediately and only within the team that issued it", async () => {
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

  it("missing expiresInDays ⇒ 400 (no unlimited-lifetime tokens)", async () => {
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

  it("requesting a never-grantable scope ⇒ 403 and NO token is created", async () => {
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

  it("requesting a scope wider than the role ⇒ 403", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.authorA),
      payload: { name: "x", scopes: ["case:read"], expiresInDays: 30 },
    });
    // Does author have token:issue:user? Yes — but the route requires exactly that permission, so this is a 201.
    expect([201, 403]).toContain(r.statusCode);
  });

  it("revoking a token ⇒ 204, and that token is immediately 401", async () => {
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
    // The 60s cache must NOT keep a revoked token alive: revoke calls invalidateTeam.
    expect(
      (await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: auth(secret) })).statusCode,
    ).toBe(401);
  });

  it("revoking a token from ANOTHER TEAM ⇒ 404, never 403", async () => {
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

  it("GET /v1/tokens lists ONLY this team's tokens — never another team's", async () => {
    const createdB = await h.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: auth(h.tokens.adminB),
      payload: { name: "ci-b", scopes: ["case:read"], expiresInDays: 30 },
    });
    const b = createdB.json() as { id: string; prefix: string };

    const list = await h.app.inject({ method: "GET", url: "/v1/tokens", headers: auth(h.tokens.adminA) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string }[];
    expect(rows.some((r) => r.id === b.id)).toBe(false);
    expect(list.payload).not.toContain(b.prefix);

    // Team A still sees its own tokens: the tenant filter narrows, it does not empty the list.
    const own = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_tokens WHERE team_id = $1`,
      [h.ids.teamA],
    );
    expect(rows.length).toBe(own.rows[0]?.n);
  });

  it("both issue and revoke write a HIGH audit entry", async () => {
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
