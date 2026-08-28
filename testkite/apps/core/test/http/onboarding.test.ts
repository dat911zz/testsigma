/**
 * Onboarding team = MỘT transaction (blueprint §3). Bộ test này canh đúng ba lời hứa:
 * đủ (team + project + admin + service token + 3 env + quota + egress observe), idempotent
 * (gọi lại cùng key không nhân đôi gì và không phát lại secret), và nguyên khối (hỏng
 * giữa chừng thì không còn team mồ côi nào).
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

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  orgId: h.ids.orgId,
  name: "Team Mới",
  slug: "team-moi",
  adminEmail: "boss@acme.test",
  baseUrl: "https://app.acme.test",
  idempotencyKey: "onboard-key-0001",
  ...over,
});

const onboard = (over: Record<string, unknown> = {}): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${h.tokens.adminA}` },
    payload: payload(over),
  });

type OnboardBody = {
  teamId: string;
  projectId: string;
  environmentIds: string[];
  serviceTokenPrefix: string;
  created: boolean;
};

describe("onboarding team", () => {
  it("một lần gọi tạo ĐỦ: team + project + admin + service token + 3 env + quota + egress observe", async () => {
    const r = await onboard();
    expect(r.statusCode).toBe(201);
    const body = r.json() as OnboardBody;
    expect(body.created).toBe(true);
    expect(body.environmentIds.length).toBe(3);

    const q = async (sqlText: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
      (await h.db.raw.query<Record<string, unknown>>(sqlText, params)).rows;
    expect((await q(`SELECT id FROM teams WHERE slug='team-moi'`)).length).toBe(1);
    expect((await q(`SELECT id FROM projects WHERE team_id=$1`, [body.teamId])).length).toBe(1);
    expect((await q(`SELECT role FROM memberships WHERE team_id=$1`, [body.teamId]))[0]).toMatchObject({
      role: "team_admin",
    });
    expect(
      (
        await q(`SELECT name, status FROM pln_environments WHERE team_id=$1 ORDER BY name`, [body.teamId])
      ).map((x) => x["name"]),
    ).toEqual(["dev", "prod", "staging"]);
    expect((await q(`SELECT * FROM quota_limits WHERE team_id=$1`, [body.teamId])).length).toBe(1);
    const egress = (
      await q(`SELECT mode, allowlist, observe_until FROM egress_policies WHERE team_id=$1`, [body.teamId])
    )[0];
    expect(egress).toMatchObject({ mode: "observe" });
    expect(String(egress?.["allowlist"])).toContain("app.acme.test");
    const tokens = await q(`SELECT kind, prefix FROM api_tokens WHERE team_id=$1`, [body.teamId]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: "service", prefix: body.serviceTokenPrefix });
  });

  it("gọi LẠI với cùng idempotencyKey ⇒ 201, created=false, KHÔNG nhân đôi gì", async () => {
    const first = (await onboard()).json() as OnboardBody;
    const second = await onboard();
    const body = second.json() as OnboardBody;
    expect(second.statusCode).toBe(201);
    expect(body.created).toBe(false);
    expect(body.teamId).toBe(first.teamId);
    const rows = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pln_environments WHERE team_id=$1`,
      [first.teamId],
    );
    expect(rows.rows[0]?.n).toBe(3);
    const tk = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_tokens WHERE team_id=$1`,
      [first.teamId],
    );
    expect(tk.rows[0]?.n).toBe(1);
    const eg = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM egress_policies WHERE team_id=$1`,
      [first.teamId],
    );
    expect(eg.rows[0]?.n).toBe(1);
  });

  it("lần gọi lại KHÔNG trả lại secret của service token (secret chỉ một lần)", async () => {
    await onboard();
    const second = await onboard();
    expect(JSON.stringify(second.json())).not.toContain("tk_");
  });

  it("slug trùng trong cùng org (idempotencyKey khác) ⇒ 409, không tạo nửa vời", async () => {
    await onboard();
    const r = await onboard({ idempotencyKey: "onboard-key-0002" });
    expect(r.statusCode).toBe(409);
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-moi'`,
    );
    expect(teams.rows[0]?.n).toBe(1);
  });

  it("lỗi giữa chừng ⇒ rollback TOÀN BỘ, không có team mồ côi", async () => {
    // base_url không phải URL ⇒ hợp đồng chặn; nếu lọt qua thì CHECK của
    // pln_environments chặn ⇒ transaction phải cuốn cả team vừa tạo.
    const r = await onboard({ slug: "team-hong", baseUrl: "khong-phai-url", idempotencyKey: "k-hong" });
    expect(r.statusCode).toBe(400);
    const rows = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-hong'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("mọi thứ tạo ra thuộc ĐÚNG team mới, không rơi sang team người gọi", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const stray = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pln_environments WHERE team_id = $1`,
      [h.ids.teamA],
    );
    expect(stray.rows[0]?.n).toBe(0);
    expect(body.teamId).not.toBe(h.ids.teamA);
  });

  it("ghi đúng MỘT audit HIGH team.onboard cho team mới", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const r = await h.db.raw.query<{ action: string; severity: string; team_id: string }>(
      `SELECT action, severity, team_id FROM audit_events WHERE action='team.onboard'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ severity: "HIGH", team_id: body.teamId });
  });

  it("thiếu quyền team:manage ⇒ 403", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
      payload: payload({ slug: "team-khac", idempotencyKey: "k2" }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("egress observe hết đúng 14 ngày kể từ lúc onboard", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const r = await h.db.raw.query<{ days: number }>(
      `SELECT round(EXTRACT(epoch FROM (observe_until - now())) / 86400)::int AS days
       FROM egress_policies WHERE team_id=$1`,
      [body.teamId],
    );
    expect(r.rows[0]?.days).toBe(14);
  });
});
