import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { startMockIdp, type MockIdp } from "../harness/mock-idp.js";

let h: TestApp;
let idp: MockIdp;
let connectorId = "";

beforeAll(async () => {
  h = await makeTestApp();
  idp = await startMockIdp();
});
afterAll(async () => {
  await idp.close();
  await h.close();
});

/** An OIDC connector for an arbitrary team — team B uses this to set up the cross-tenant case. */
async function newConnector(teamId: string, name: string): Promise<string> {
  const r = await h.db.raw.query<{ id: string }>(
    `INSERT INTO idn_oidc_connectors (team_id, name, issuer_url, client_id, client_secret, scopes, default_role, allow_insecure_http)
     VALUES ($1,$2,$3,$4,$5,ARRAY['openid','email','groups'],'viewer',true) RETURNING id`,
    [teamId, name, idp.issuer, idp.clientId, idp.clientSecret],
  );
  return String(r.rows[0]?.id);
}

beforeEach(async () => {
  await h.seed();
  connectorId = await newConnector(h.ids.teamA, "keycloak");
});

const REDIRECT = "http://127.0.0.1:8080/v1/auth/oidc/callback";

async function start(cid = connectorId): Promise<{ authorizationUrl: string; state: string }> {
  const r = await h.app.inject({
    method: "POST",
    url: `/v1/auth/oidc/${cid}/start`,
    payload: { redirectUri: REDIRECT },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { authorizationUrl: string; state: string };
}

/** Walks the mock IdP to get the callback URL, and can force it to issue a malicious token. */
async function walkIdp(
  authorizationUrl: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const u = new URL(authorizationUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "manual" });
  const loc = res.headers.get("location");
  expect(loc, "IdP did not return a redirect").not.toBeNull();
  return String(loc);
}

const callback = (
  callbackUrl: string,
  cid = connectorId,
): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({
    method: "POST",
    url: `/v1/auth/oidc/${cid}/callback`,
    payload: { callbackUrl },
  });

/** One full login round-trip through the mock IdP, on connector `cid`. */
async function login(
  cid: string,
  extra: Record<string, string> = {},
): ReturnType<TestApp["app"]["inject"]> {
  const { authorizationUrl } = await start(cid);
  return callback(await walkIdp(authorizationUrl, extra), cid);
}

const userIdOf = (r: { json: () => unknown }): string =>
  (r.json() as { context: { userId: string } }).context.userId;

describe("OIDC connector", () => {
  it("start returns an authorization URL with PKCE S256 + state + nonce", async () => {
    const { authorizationUrl, state } = await start();
    const u = new URL(authorizationUrl);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("nonce")?.length).toBeGreaterThan(10);
    expect(u.searchParams.get("client_id")).toBe(idp.clientId);
  });

  it("a valid callback ⇒ 200 + a usable session token, the user is auto-created", async () => {
    const { authorizationUrl } = await start();
    const cb = await walkIdp(authorizationUrl, { tk_email: "moi@acme.test" });
    const r = await callback(cb);
    expect(r.statusCode).toBe(200);
    const body = r.json() as { secret: string; context: { teamId: string; role: string } };
    expect(body.context).toMatchObject({ teamId: h.ids.teamA, role: "viewer" });
    const me = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(me.statusCode).toBe(200);
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email='moi@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("logging in a second time does NOT create a duplicate user", async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await login(connectorId, { tk_email: "lap@acme.test", tk_sub: "kc-user-9" });
      expect(r.statusCode).toBe(200);
    }
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email='lap@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("anchored by SUBJECT: a second login with a different email but the same subject ⇒ still the same user", async () => {
    // This is what distinguishes "anchored by subject" from "blind email matching": with
    // email-only matching, a changed email would spawn a second user. The reverse case
    // (subject changes, email stays) is in the "cross-tenant session hijack" group below.
    const first = await login(connectorId, { tk_email: "neo@acme.test", tk_sub: "kc-neo" });
    expect(first.statusCode).toBe(200);

    const second = await login(connectorId, { tk_email: "neo-doi@acme.test", tk_sub: "kc-neo" });
    expect(second.statusCode).toBe(200);
    expect(userIdOf(second)).toBe(userIdOf(first));

    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email LIKE 'neo%@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("an EXPIRED id_token ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect((await callback(await walkIdp(authorizationUrl, { tk_mode: "expired" }))).statusCode).toBe(
      401,
    );
  });

  it("id_token with the wrong audience ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "wrong_aud" }))).statusCode,
    ).toBe(401);
  });

  it("id_token with the wrong issuer ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "wrong_iss" }))).statusCode,
    ).toBe(401);
  });

  it("id_token signed with a key OUTSIDE the JWKS ⇒ 401 (enableNonRepudiationChecks)", async () => {
    // Without the signature check enabled, openid-client ACCEPTS this token (spike 2026-08-28).
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "unknown_kid" }))).statusCode,
    ).toBe(401);
  });

  it("state REUSED a second time ⇒ 401 (replay protection)", async () => {
    const { authorizationUrl } = await start();
    const cb = await walkIdp(authorizationUrl);
    expect((await callback(cb)).statusCode).toBe(200);
    expect((await callback(cb)).statusCode).toBe(401);
  });

  it("expired state ⇒ 401", async () => {
    const { authorizationUrl, state } = await start();
    const cb = await walkIdp(authorizationUrl);
    await h.db.raw.query(
      `UPDATE idn_oidc_login_states SET expires_at = now() - interval '1 minute' WHERE state = $1`,
      [state],
    );
    expect((await callback(cb)).statusCode).toBe(401);
  });

  it("a made-up state (not in the DB) ⇒ 401", async () => {
    expect((await callback(`${REDIRECT}?code=abc&state=khong-ton-tai`)).statusCode).toBe(401);
  });

  it("start is a PUBLIC route: another team's connector still 200s, returning only the authorization URL + state", async () => {
    // The REAL behavior, stated plainly: /start runs before any credential exists, so
    // there's no tenant ctx to compare against — the connector id is a random uuid, acting
    // as a capability. What must hold is that the body does NOT leak another team's
    // connector name.
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await h.app.inject({
      method: "POST",
      url: `/v1/auth/oidc/${cidB}/start`,
      payload: { redirectUri: REDIRECT },
    });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json() as Record<string, unknown>).sort()).toEqual([
      "authorizationUrl",
      "state",
    ]);
    expect(r.payload).not.toContain("kc-b");
  });

  it("start's ERROR branch ⇒ a clean 404: no 403, no 500, no leaking another team's name/issuer", async () => {
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    await h.db.raw.query(`UPDATE idn_oidc_connectors SET enabled=false WHERE id=$1`, [cidB]);
    const r = await h.app.inject({
      method: "POST",
      url: `/v1/auth/oidc/${cidB}/start`,
      payload: { redirectUri: REDIRECT },
    });
    expect(r.statusCode).toBe(404);
    expect(r.payload).not.toContain("kc-b");
    expect(r.payload).not.toContain(idp.issuer);
  });

  it("a disabled connector ⇒ 404", async () => {
    await h.db.raw.query(`UPDATE idn_oidc_connectors SET enabled = false WHERE id = $1`, [
      connectorId,
    ]);
    const r = await h.app.inject({
      method: "POST",
      url: `/v1/auth/oidc/${connectorId}/start`,
      payload: { redirectUri: REDIRECT },
    });
    expect(r.statusCode).toBe(404);
  });

  it("client_secret NEVER leaves the API", async () => {
    const { authorizationUrl } = await start();
    const r = await callback(await walkIdp(authorizationUrl));
    expect(JSON.stringify(r.json())).not.toContain(idp.clientSecret);
    expect(authorizationUrl).not.toContain(idp.clientSecret);
  });

  it("an OIDC login writes a LOW audit entry with the connector and subject", async () => {
    const { authorizationUrl } = await start();
    await callback(await walkIdp(authorizationUrl, { tk_sub: "kc-user-77" }));
    const r = await h.db.raw.query<{ action: string; severity: string; meta: { subject?: string } }>(
      `SELECT action, severity, meta FROM audit_events WHERE action LIKE 'auth.oidc%'`,
    );
    expect(r.rows[0]?.action).toBe("auth.oidc_login");
    expect(r.rows[0]?.severity).toBe("LOW");
    expect(r.rows[0]?.meta.subject).toBe("kc-user-77");
  });
});

/**
 * `users` is a GLOBAL table (schema.ts: "one person, many teams"), while each team
 * configures its own OIDC connector — team B's admin points it at their own Keycloak and
 * can declare whatever claims they like. If a callback linked a new identity to an
 * existing user by email ALONE, team B could mint a session carrying the real userId of
 * someone who only belongs to team A.
 */
describe("OIDC — resisting cross-tenant session hijack via email", () => {
  it("team B claims the email of a user who ONLY belongs to team A ⇒ 401, no session, no membership", async () => {
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await login(cidB, { tk_email: "author@acme.test", tk_sub: "kc-ke-tan-cong" });
    expect(r.statusCode).toBe(401);

    const m = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE team_id=$1 AND user_id=$2`,
      [h.ids.teamB, h.ids.authorUser],
    );
    expect(m.rows[0]?.n).toBe(0);
    const tok = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_tokens WHERE team_id=$1 AND user_id=$2`,
      [h.ids.teamB, h.ids.authorUser],
    );
    expect(tok.rows[0]?.n).toBe(0);
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE lower(email)='author@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("a user who is ALREADY a team member (invited by the team) + verified email ⇒ links to that exact user", async () => {
    // The boundary of the rule: a team may ONLY link to an account it has already vouched
    // for via membership — that's the valid "invite first, SSO later" flow.
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await login(cidB, { tk_email: "admin@acme.test", tk_sub: "kc-admin" });
    expect(r.statusCode).toBe(200);
    expect(userIdOf(r)).toBe(h.ids.adminUser);
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE lower(email)='admin@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("email already belongs to someone + the IdP says email_verified=false ⇒ 401 even though the user is a team member", async () => {
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await login(cidB, {
      tk_email: "admin@acme.test",
      tk_sub: "kc-chua-xac-minh",
      tk_email_verified: "false",
    });
    expect(r.statusCode).toBe(401);
  });

  it("a newly JIT-created user: the IdP doesn't verify the email ⇒ email_verified_at is NULL", async () => {
    for (const [verified, email] of [
      ["false", "chua-xac-minh@acme.test"],
      // The IdP staying silent (not sending the claim) also counts as NOT verified — and
      // login still succeeds: if no one uses that email yet, there's no account to take over.
      ["absent", "im-lang@acme.test"],
    ] as const) {
      const r = await login(connectorId, {
        tk_email: email,
        tk_sub: `kc-${verified}`,
        tk_email_verified: verified,
      });
      expect(r.statusCode).toBe(200);
      const u = await h.db.raw.query<{ v: string | null }>(
        `SELECT email_verified_at AS v FROM users WHERE email=$1`,
        [email],
      );
      expect(u.rows.length).toBe(1);
      expect(u.rows[0]?.v).toBeNull();
    }
  });
});
