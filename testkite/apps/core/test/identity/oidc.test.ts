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

/**
 * An OIDC connector for an arbitrary team — team B uses this to set up the cross-tenant
 * case. `roleMapping` is the IdP group -> TestKite role table; empty (the default) means
 * every login falls back to `default_role`.
 */
async function newConnector(
  teamId: string,
  name: string,
  roleMapping: Record<string, string> = {},
): Promise<string> {
  const r = await h.db.raw.query<{ id: string }>(
    `INSERT INTO idn_oidc_connectors (team_id, name, issuer_url, client_id, client_secret, scopes, default_role, allow_insecure_http, role_mapping)
     VALUES ($1,$2,$3,$4,$5,ARRAY['openid','email','groups'],'viewer',true,$6::jsonb) RETURNING id`,
    [teamId, name, idp.issuer, idp.clientId, idp.clientSecret, JSON.stringify(roleMapping)],
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

/**
 * The membership role is provisioned FROM the IdP's groups, so it has to keep following
 * them. Writing it only on the very first login froze it forever: a group revoked at the
 * IdP — the one direction that must never lag — never reached TestKite, and the person
 * kept the role their old groups had bought them for as long as the account existed.
 */
describe("OIDC — the membership role is re-synced from the IdP on every login", () => {
  const ADMIN_GROUP = "acme-admins";
  const MAPPING = { [ADMIN_GROUP]: "team_admin" };

  const roleOf = async (userId: string): Promise<string | undefined> => {
    const r = await h.db.raw.query<{ role: string }>(
      `SELECT role FROM memberships WHERE team_id=$1 AND user_id=$2`,
      [h.ids.teamA, userId],
    );
    return r.rows[0]?.role;
  };

  const listMembers = (secret: string): ReturnType<TestApp["app"]["inject"]> =>
    h.app.inject({
      method: "GET",
      url: "/v1/members",
      headers: { authorization: `Bearer ${secret}` },
    });

  const roleChangeEvents = async (): Promise<
    { severity: string; meta: Record<string, unknown> }[]
  > => {
    const r = await h.db.raw.query<{ severity: string; meta: Record<string, unknown> }>(
      `SELECT severity, meta FROM audit_events WHERE action='member.role_change' ORDER BY occurred_at`,
    );
    return r.rows;
  };

  it("a group removed at the IdP downgrades the stored role, and the OLD session token loses the permission", async () => {
    const cid = await newConnector(h.ids.teamA, "kc-sync", MAPPING);

    // Login 1: the IdP still asserts the admin group.
    const first = await login(cid, {
      tk_sub: "kc-sync",
      tk_email: "sync@acme.test",
      tk_groups: ADMIN_GROUP,
    });
    expect(first.statusCode).toBe(200);
    const userId = userIdOf(first);
    const oldSecret = (first.json() as { secret: string }).secret;
    expect(await roleOf(userId)).toBe("team_admin");
    expect((await listMembers(oldSecret)).statusCode).toBe(200);

    // Login 2: the group is gone, so the mapping no longer matches and the connector's
    // default_role (viewer) applies.
    const second = await login(cid, {
      tk_sub: "kc-sync",
      tk_email: "sync@acme.test",
      tk_groups: "",
    });
    expect(second.statusCode).toBe(200);
    expect(userIdOf(second)).toBe(userId);
    expect(await roleOf(userId)).toBe("viewer");

    // `member:manage` is HIGH_RISK ⇒ the auth hook asks for a FRESH lookup, so the 60s
    // cache cannot keep the revoked permission alive either.
    const after = await listMembers(oldSecret);
    expect(after.statusCode).toBe(403);
  });

  it("an IdP-driven role change writes a HIGH audit entry naming both roles", async () => {
    const cid = await newConnector(h.ids.teamA, "kc-audit", MAPPING);
    await login(cid, { tk_sub: "kc-audit", tk_email: "audit@acme.test", tk_groups: ADMIN_GROUP });
    await login(cid, { tk_sub: "kc-audit", tk_email: "audit@acme.test", tk_groups: "" });

    const events = await roleChangeEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.severity).toBe("HIGH");
    expect(events[0]?.meta).toMatchObject({ from: "team_admin", to: "viewer", source: "oidc" });
  });

  it("a login that does NOT change the role writes no audit entry (the log is not a login feed)", async () => {
    const cid = await newConnector(h.ids.teamA, "kc-stable", MAPPING);
    for (let i = 0; i < 3; i += 1) {
      const r = await login(cid, {
        tk_sub: "kc-stable",
        tk_email: "stable@acme.test",
        tk_groups: ADMIN_GROUP,
      });
      expect(r.statusCode).toBe(200);
    }
    expect(await roleChangeEvents()).toEqual([]);
  });

  it("an UPGRADE is synced too, and the role stays inside the connector's own team", async () => {
    const cid = await newConnector(h.ids.teamA, "kc-up", MAPPING);
    const first = await login(cid, { tk_sub: "kc-up", tk_email: "up@acme.test", tk_groups: "none" });
    const userId = userIdOf(first);
    expect(await roleOf(userId)).toBe("viewer");

    await login(cid, { tk_sub: "kc-up", tk_email: "up@acme.test", tk_groups: ADMIN_GROUP });
    expect(await roleOf(userId)).toBe("team_admin");

    const other = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE team_id=$1 AND user_id=$2`,
      [h.ids.teamB, userId],
    );
    expect(other.rows[0]?.n).toBe(0);
  });
});
