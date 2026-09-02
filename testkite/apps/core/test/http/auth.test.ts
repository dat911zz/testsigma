import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";

let h: TestApp;
beforeAll(async () => { h = await makeTestApp(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.seed(); });

describe("auth hook", () => {
  it("a public route needs no credential", async () => {
    expect((await h.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("missing Authorization ⇒ 401 UNAUTHORIZED", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a made-up / malformed / well-formed-but-not-in-DB token ⇒ 401", async () => {
    for (const bad of ["Bearer abc", "Bearer tk_00000000_khong-ton-tai-nhung-du-dai-hon-20", "Token x", ""]) {
      const r = await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: bad } });
      expect(r.statusCode, bad).toBe(401);
    }
  });

  it("a valid token ⇒ 200 and the context's teamId comes from the TOKEN, not the client", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ teamId: h.ids.teamA, role: "author", authKind: "api_token" });
  });

  it("the effective scope in /me = token ∩ role (a token requesting member:manage gets it trimmed)", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorAOverreach}` },
    });
    const body = r.json() as { scopes: string[] };
    expect(body.scopes).toContain("case:read");
    expect(body.scopes).not.toContain("member:manage");
  });

  it("an expired token ⇒ 401", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.expiredA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("a revoked token ⇒ 401", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.revokedA}` },
    });
    expect(r.statusCode).toBe(401);
  });

  it("missing the route's permission ⇒ 403 (within one's own team)", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/members",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("having the permission ⇒ 200", async () => {
    const r = await h.app.inject({
      method: "GET", url: "/v1/members",
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it("60s cache: the second call doesn't hit the DB again", async () => {
    h.counters.reset();
    await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${h.tokens.authorA}` } });
    const first = h.counters.authLookups;
    await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${h.tokens.authorA}` } });
    expect(first).toBe(1);
    expect(h.counters.authLookups).toBe(1);
  });

  it("a HIGH action BYPASSES the cache — always hits the DB again", async () => {
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    h.counters.reset();
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    expect(h.counters.authLookups).toBe(2);
  });

  it("mid-flight role demotion: a HIGH action sees it immediately, doesn't wait out the TTL", async () => {
    await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    await h.demoteAdminToViewer();
    const r = await h.app.inject({ method: "GET", url: "/v1/members", headers: { authorization: `Bearer ${h.tokens.adminA}` } });
    expect(r.statusCode).toBe(403);
  });

  it("demotion via the API: a NON-HIGH action also loses the permission IMMEDIATELY, without waiting out the 60s TTL", async () => {
    // The "mid-flight demotion" test above goes through /v1/members (member:manage = HIGH
    // ⇒ always fresh), so it proves nothing about the cache. This test uses /v1/auth/me
    // (permission null ⇒ NOT HIGH ⇒ goes through the cache): if setMemberRole doesn't
    // clear the cache, the just-revoked permission stays in effect for up to 60 seconds.
    const before = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(before.json()).toMatchObject({ role: "author" });
    expect((before.json() as { scopes: string[] }).scopes).toContain("case:write");

    const patched = await h.app.inject({
      method: "PATCH", url: `/v1/members/${h.ids.authorUser}`,
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
      payload: { role: "viewer" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ role: "viewer" });

    const after = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
    });
    expect(after.json()).toMatchObject({ role: "viewer" });
    expect((after.json() as { scopes: string[] }).scopes).not.toContain("case:write");
  });

  it("a token from team B can NEVER see team A's data — a real cross-tenant request, not just its own /me", async () => {
    // The exhaustive version of this rule (every route × path param) lives in
    // isolation/cross-tenant.test.ts; this is a standalone smoke test kept right next to
    // the auth hook's other assertions, so this file alone still proves the 404-not-403
    // rule end to end without depending on that generated suite.
    const created = await h.app.inject({
      method: "POST",
      url: `/v1/projects/${h.ids.projectA}/cases`,
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
      payload: { name: "Team A's case", isStepGroup: false },
    });
    expect(created.statusCode).toBe(201);
    const caseId = created.json<{ id: string }>().id;

    const r = await h.app.inject({
      method: "GET",
      url: `/v1/cases/${caseId}`,
      headers: { authorization: `Bearer ${h.tokens.adminB}` },
    });
    expect(r.statusCode).toBe(404);
    expect(r.statusCode).not.toBe(403);
  });

  it("a token that expires INSIDE the 60s cache window is refused on the next request", async () => {
    // /v1/auth/me carries `permission: null` ⇒ NOT a HIGH action ⇒ it reads the cache. The
    // first call seeds the entry; 31 seconds later the CREDENTIAL is dead but the ENTRY is
    // still fresh (TTL 60s), and before this fix the cached grant carried no expiry of its
    // own, so it kept authenticating for the rest of the minute. Measured on the same test
    // before the fix: 200.
    const first = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.shortLivedA}` },
    });
    expect(first.statusCode).toBe(200);

    h.clock.advance(31_000);

    const after = await h.app.inject({
      method: "GET", url: "/v1/auth/me",
      headers: { authorization: `Bearer ${h.tokens.shortLivedA}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("a live token is still served from the cache — the expiry check is not a blanket miss", async () => {
    // The companion assertion to the one above: if refusing an expired grant had been
    // written as "always re-read", the 60s TTL would be decorative and every request would
    // pay a round-trip.
    h.counters.reset();
    for (let i = 0; i < 2; i += 1) {
      const r = await h.app.inject({
        method: "GET", url: "/v1/auth/me",
        headers: { authorization: `Bearer ${h.tokens.shortLivedA}` },
      });
      expect(r.statusCode).toBe(200);
    }
    expect(h.counters.authLookups).toBe(1);
  });

  it("every response carries a requestId for log tracing", async () => {
    const r = await h.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect((r.json() as { requestId: string }).requestId.length).toBeGreaterThan(0);
  });
});
