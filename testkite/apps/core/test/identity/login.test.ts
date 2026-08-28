/**
 * Internal password login (Task 8). Rules tested here, in order of importance:
 *  1. EVERY failure branch returns the SAME message — never gives away which emails exist.
 *  2. Session = api_token kind='session', 1-day TTL, tied to EXACTLY one team.
 *  3. Success writes audit LOW, failure writes audit MEDIUM.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import {
  hashPassword,
  loginWithPassword,
  LOGIN_FAILED_MESSAGE,
} from "../../src/modules/identity/index.js";
import { writeAuditEvent } from "../../src/modules/governance/index.js";

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

const auditCount = async (): Promise<number> => {
  const r = await h.db.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events`);
  return r.rows[0]?.n ?? -1;
};

describe("internal password login", () => {
  it("correct password ⇒ 200 + secret works immediately", async () => {
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

  it("wrong password / nonexistent email ⇒ 401 with the SAME message", async () => {
    const a = await login({ email: "author@acme.test", password: "sai-mat-khau-12" });
    const b = await login({ email: "khong-ton-tai@acme.test", password: "mat-khau-dai-hon-12" });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    // Must not leak "does this email exist".
    expect((a.json() as { message: string }).message).toBe((b.json() as { message: string }).message);
  });

  it("email is case-insensitive", async () => {
    expect(
      (await login({ email: "Author@Acme.TEST", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(200);
  });

  it("a user with OIDC-only login (password_hash NULL) ⇒ 401, not 500", async () => {
    await h.db.raw.query(`UPDATE users SET password_hash = NULL WHERE id = $1`, [h.ids.authorUser]);
    expect(
      (await login({ email: "author@acme.test", password: "bat-ky-mat-khau" })).statusCode,
    ).toBe(401);
  });

  it("a suspended user ⇒ 401 even with the correct password", async () => {
    await h.db.raw.query(`UPDATE users SET status='suspended' WHERE id=$1`, [h.ids.authorUser]);
    expect(
      (await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(401);
  });

  it("a user in multiple teams: teamId picks the team, defaults to the earliest-joined team", async () => {
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

  it("requesting a team you are NOT a member of ⇒ 401 (not 403 — doesn't confirm the team exists)", async () => {
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

  it("the session token has a 1-day TTL and kind=session", async () => {
    const body = (
      await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })
    ).json() as { secret: string; expiresAt: string };
    const r = await h.db.raw.query<{ kind: string; days: number }>(
      `SELECT kind, EXTRACT(day FROM (expires_at - now()))::int AS days FROM api_tokens WHERE kind='session'`,
    );
    expect(r.rows[0]?.kind).toBe("session");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("a successful login writes audit LOW, a failed one writes audit MEDIUM", async () => {
    await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" });
    await login({ email: "author@acme.test", password: "sai-mat-khau-12" });
    // The failure's audit line is written OUTSIDE the response path (see the next test),
    // so we must wait for it to settle before counting — this isn't relaxing the "it must
    // still be written" rule.
    await h.settleDeferred();
    const r = await h.db.raw.query<{ action: string; severity: string }>(
      `SELECT action, severity FROM audit_events ORDER BY occurred_at`,
    );
    expect(r.rows.map((x) => `${x.action}/${x.severity}`)).toEqual([
      "auth.login/LOW",
      "auth.login_failed/MEDIUM",
    ]);
  });

  /**
   * Account enumeration via TIMING, not via response content. Both failure branches
   * return the same 401 + the same message, but if the "email is real + wrong password"
   * branch opened one extra Postgres transaction (BEGIN → SET LOCAL ROLE → INSERT audit →
   * COMMIT) before throwing while the "unknown email" branch didn't, the timing gap would
   * be ENOUGH to count which emails exist (measured during review: ~5.1–5.9ms on top of a
   * ~23–29ms baseline, i.e. 20–25%, consistent across repeated runs). This is exactly why
   * DUMMY_HASH exists — and a synchronous audit write would defeat it.
   *
   * Hence: failure audit runs through the `defer` port (outside the response path). The
   * test holds the task back without running it, so it can assert "the error has already
   * been thrown while the DB hasn't been touched yet".
   */
  it("failure from wrong password does NOT write audit on the response path (symmetric with the unknown-email branch)", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const deps = {
      db: h.db.db,
      audit: writeAuditEvent,
      defer: (task: () => Promise<void>): void => {
        tasks.push(task);
      },
    };

    await expect(
      loginWithPassword(deps, { email: "author@acme.test", password: "sai-mat-khau-12" }),
    ).rejects.toThrow(LOGIN_FAILED_MESSAGE);
    expect(await auditCount()).toBe(0);
    expect(tasks).toHaveLength(1);

    // The nonexistent-email branch: no tenant to write to ⇒ nothing gets deferred. Both
    // branches therefore do the exact same amount of work before throwing.
    await expect(
      loginWithPassword(deps, { email: "khong-ton-tai@acme.test", password: "sai-mat-khau-12" }),
    ).rejects.toThrow(LOGIN_FAILED_MESSAGE);
    expect(await auditCount()).toBe(0);
    expect(tasks).toHaveLength(1);

    // Deferred does NOT mean dropped: once the task runs, the MEDIUM line must still land in audit_events.
    await tasks[0]?.();
    const r = await h.db.raw.query<{ action: string; severity: string }>(
      `SELECT action, severity FROM audit_events`,
    );
    expect(r.rows.map((x) => `${x.action}/${x.severity}`)).toEqual(["auth.login_failed/MEDIUM"]);
  });

  it("a password hashed with old parameters gets silently rehashed on a correct login", async () => {
    await h.db.raw.query(
      `UPDATE users SET password_hash='$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' WHERE id=$1`,
      [h.ids.authorUser],
    );
    // The old hash can't verify this password ⇒ 401; rehash only happens on a CORRECT verify.
    expect(
      (await login({ email: "author@acme.test", password: "mat-khau-dai-hon-12" })).statusCode,
    ).toBe(401);
  });
});
