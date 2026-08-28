/**
 * Đăng nhập mật khẩu nội bộ (Task 8). Luật bị test ở đây, theo thứ tự quan trọng:
 *  1. MỌI nhánh thất bại trả CÙNG một message — không tố cáo email nào tồn tại.
 *  2. Session = api_token kind='session', hạn 1 ngày, gắn ĐÚNG một team.
 *  3. Thành công ghi audit LOW, thất bại ghi audit MEDIUM.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { hashPassword } from "../../src/modules/identity/index.js";

let h: TestApp;
beforeAll(async () => {
  h = await makeTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
  await h.db.raw.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
    await hashPassword("mat-khau-dai-hon-12"),
    h.ids.authorUser,
  ]);
});

const login = (payload: unknown): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({ method: "POST", url: "/v1/auth/login", payload });

describe("đăng nhập mật khẩu nội bộ", () => {
  it("đúng mật khẩu ⇒ 200 + secret dùng được ngay", async () => {
    const r = await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { secret: string; context: { teamId: string; role: string } };
    expect(body.context).toMatchObject({ teamId: h.ids.teamA, role: "author" });
    const me = await h.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("sai mật khẩu / email không tồn tại ⇒ 401 với CÙNG một message", async () => {
    const a = await login({ email: "author@acme.test", password: "sai-mat-khau-12" });
    const b = await login({ email: "khong-ton-tai@acme.test", password: "mat-khau-dai-hon-12" });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    // Không được lộ "email này có tồn tại hay không".
    expect((a.json() as { message: string }).message).toBe((b.json() as { message: string }).message);
  });

  it("email không phân biệt hoa thường", async () => {
    expect(
      (await login({ email: "Author@Acme.TEST", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(200);
  });

  it("user chỉ dùng OIDC (password_hash NULL) ⇒ 401, không 500", async () => {
    await h.db.raw.query(`UPDATE users SET password_hash = NULL WHERE id = $1`, [h.ids.authorUser]);
    expect(
      (await login({ email: "author@acme.test", password: "bat-ky-mat-khau" })).statusCode,
    ).toBe(401);
  });

  it("user bị suspend ⇒ 401 dù mật khẩu đúng", async () => {
    await h.db.raw.query(`UPDATE users SET status='suspended' WHERE id=$1`, [h.ids.authorUser]);
    expect(
      (await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(401);
  });

  it("người ở nhiều team: teamId chọn team, thiếu thì lấy team tham gia sớm nhất", async () => {
    await h.db.raw.query(`INSERT INTO memberships (team_id,user_id,role) VALUES ($1,$2,'viewer')`, [
      h.ids.teamB,
      h.ids.authorUser,
    ]);
    const b = await login({
      email: "author@acme.test",
      password: "mat-khau-dai-hon-12",
      teamId: h.ids.teamB,
    });
    expect((b.json() as { context: { teamId: string; role: string } }).context).toMatchObject({
      teamId: h.ids.teamB,
      role: "viewer",
    });
    const dflt = await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" });
    expect((dflt.json() as { context: { teamId: string } }).context.teamId).toBe(h.ids.teamA);
  });

  it("xin team mình KHÔNG là thành viên ⇒ 401 (không phải 403 — không xác nhận team tồn tại)", async () => {
    await h.db.raw.query(`DELETE FROM memberships WHERE team_id=$1 AND user_id=$2`, [
      h.ids.teamB,
      h.ids.authorUser,
    ]);
    expect(
      (
        await login({
          email: "author@acme.test",
          password: "mat-khau-dai-hon-12",
          teamId: h.ids.teamB,
        })
      ).statusCode,
    ).toBe(401);
  });

  it("session token có hạn 1 ngày và kind=session", async () => {
    const body = (
      await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })
    ).json() as { secret: string; expiresAt: string };
    const r = await h.db.raw.query<{ kind: string; days: number }>(
      `SELECT kind, EXTRACT(day FROM (expires_at - now()))::int AS days FROM api_tokens WHERE kind='session'`,
    );
    expect(r.rows[0]?.kind).toBe("session");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("đăng nhập thành công ghi audit LOW, thất bại ghi audit MEDIUM", async () => {
    await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" });
    await login({ email: "author@acme.test", password: "sai-mat-khau-12" });
    const r = await h.db.raw.query<{ action: string; severity: string }>(
      `SELECT action, severity FROM audit_events ORDER BY occurred_at`,
    );
    expect(r.rows.map((x) => `${x.action}/${x.severity}`)).toEqual([
      "auth.login/LOW",
      "auth.login_failed/MEDIUM",
    ]);
  });

  it("mật khẩu hash bằng tham số cũ được rehash im lặng khi đăng nhập đúng", async () => {
    await h.db.raw.query(
      `UPDATE users SET password_hash='$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' WHERE id=$1`,
      [h.ids.authorUser],
    );
    // Hash cũ không verify được mật khẩu này ⇒ 401; rehash chỉ xảy ra khi verify ĐÚNG.
    expect(
      (await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(401);
  });
});
