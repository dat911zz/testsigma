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

/** Connector OIDC của một team bất kỳ — team B dùng để dựng ca xuyên-tenant. */
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

/** Đi qua IdP giả để lấy callback URL, có thể ép nó phát token độc hại. */
async function walkIdp(
  authorizationUrl: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const u = new URL(authorizationUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "manual" });
  const loc = res.headers.get("location");
  expect(loc, "IdP không trả redirect").not.toBeNull();
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

/** Một lượt đăng nhập trọn vẹn qua IdP giả, trên connector `cid`. */
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
  it("start trả authorization URL có PKCE S256 + state + nonce", async () => {
    const { authorizationUrl, state } = await start();
    const u = new URL(authorizationUrl);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("nonce")?.length).toBeGreaterThan(10);
    expect(u.searchParams.get("client_id")).toBe(idp.clientId);
  });

  it("callback hợp lệ ⇒ 200 + session token dùng được, user được tạo tự động", async () => {
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

  it("đăng nhập lần hai KHÔNG tạo user trùng", async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = await login(connectorId, { tk_email: "lap@acme.test", tk_sub: "kc-user-9" });
      expect(r.statusCode).toBe(200);
    }
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE email='lap@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("neo theo SUBJECT: lần hai đổi email nhưng cùng subject ⇒ vẫn đúng user cũ", async () => {
    // Đây là thứ phân biệt "có neo theo subject" với "khớp mù theo email": nếu chỉ
    // khớp email thì email đổi ⇒ đẻ ra user thứ hai. Ca ngược (đổi subject, giữ
    // email) nằm ở nhóm "chống chiếm phiên xuyên-tenant" bên dưới.
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

  it("id_token HẾT HẠN ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect((await callback(await walkIdp(authorizationUrl, { tk_mode: "expired" }))).statusCode).toBe(
      401,
    );
  });

  it("id_token sai audience ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "wrong_aud" }))).statusCode,
    ).toBe(401);
  });

  it("id_token sai issuer ⇒ 401", async () => {
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "wrong_iss" }))).statusCode,
    ).toBe(401);
  });

  it("id_token ký bằng khoá NGOÀI JWKS ⇒ 401 (enableNonRepudiationChecks)", async () => {
    // Không bật kiểm chữ ký thì openid-client CHẤP NHẬN token này (spike 2026-08-28).
    const { authorizationUrl } = await start();
    expect(
      (await callback(await walkIdp(authorizationUrl, { tk_mode: "unknown_kid" }))).statusCode,
    ).toBe(401);
  });

  it("state dùng LẠI lần hai ⇒ 401 (chống replay)", async () => {
    const { authorizationUrl } = await start();
    const cb = await walkIdp(authorizationUrl);
    expect((await callback(cb)).statusCode).toBe(200);
    expect((await callback(cb)).statusCode).toBe(401);
  });

  it("state hết hạn ⇒ 401", async () => {
    const { authorizationUrl, state } = await start();
    const cb = await walkIdp(authorizationUrl);
    await h.db.raw.query(
      `UPDATE idn_oidc_login_states SET expires_at = now() - interval '1 minute' WHERE state = $1`,
      [state],
    );
    expect((await callback(cb)).statusCode).toBe(401);
  });

  it("state bịa (không có trong DB) ⇒ 401", async () => {
    expect((await callback(`${REDIRECT}?code=abc&state=khong-ton-tai`)).statusCode).toBe(401);
  });

  it("start là route CÔNG KHAI: connector team khác vẫn 200, chỉ trả URL uỷ quyền + state", async () => {
    // Hành vi THẬT, nói thẳng: /start chạy khi chưa có credential nào nên không có
    // tenant ctx để so — id connector là uuid ngẫu nhiên, đóng vai capability. Điều
    // phải giữ là body KHÔNG rò tên connector của team khác.
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

  it("nhánh LỖI của start ⇒ 404 sạch: không 403, không 500, không rò tên/issuer team khác", async () => {
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

  it("connector disabled ⇒ 404", async () => {
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

  it("client_secret KHÔNG BAO GIỜ ra khỏi API", async () => {
    const { authorizationUrl } = await start();
    const r = await callback(await walkIdp(authorizationUrl));
    expect(JSON.stringify(r.json())).not.toContain(idp.clientSecret);
    expect(authorizationUrl).not.toContain(idp.clientSecret);
  });

  it("đăng nhập OIDC ghi audit LOW kèm connector và subject", async () => {
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
 * `users` là bảng TOÀN CỤC (schema.ts: "một người ở nhiều team"), còn connector OIDC
 * thì mỗi team tự cấu hình lấy — admin team B trỏ về Keycloak của chính họ và khai
 * claim gì cũng được. Nếu callback khớp identity mới vào user cũ CHỈ bằng email thì
 * team B mint được phiên mang userId thật của người chỉ thuộc team A.
 */
describe("OIDC — chống chiếm phiên xuyên-tenant qua email", () => {
  it("team B khai email của user CHỈ thuộc team A ⇒ 401, không phiên, không membership", async () => {
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

  it("user ĐÃ là thành viên team (team tự mời) + email đã xác minh ⇒ liên kết đúng user đó", async () => {
    // Ranh giới của luật: team CHỈ được liên kết vào tài khoản mà chính nó đã bảo
    // lãnh bằng membership — đó là luồng "mời trước, SSO sau" hợp lệ.
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await login(cidB, { tk_email: "admin@acme.test", tk_sub: "kc-admin" });
    expect(r.statusCode).toBe(200);
    expect(userIdOf(r)).toBe(h.ids.adminUser);
    const u = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE lower(email)='admin@acme.test'`,
    );
    expect(u.rows[0]?.n).toBe(1);
  });

  it("email đã có chủ + IdP nói email_verified=false ⇒ 401 dù user là thành viên team", async () => {
    const cidB = await newConnector(h.ids.teamB, "kc-b");
    const r = await login(cidB, {
      tk_email: "admin@acme.test",
      tk_sub: "kc-chua-xac-minh",
      tk_email_verified: "false",
    });
    expect(r.statusCode).toBe(401);
  });

  it("user JIT tạo mới: IdP không xác minh email ⇒ email_verified_at NULL", async () => {
    for (const [verified, email] of [
      ["false", "chua-xac-minh@acme.test"],
      // IdP im lặng (không phát claim) cũng là CHƯA xác minh — và vẫn đăng nhập được:
      // email chưa ai dùng thì không có tài khoản nào để chiếm.
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
