/**
 * Onboarding team = MỘT transaction (blueprint §3). Bộ test này canh đúng ba lời hứa:
 * đủ (team + project + admin + service token + 3 env + quota + egress observe), idempotent
 * (gọi lại cùng key không nhân đôi gì và không phát lại secret), và nguyên khối (hỏng
 * giữa chừng thì không còn team mồ côi nào).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { onboardTeam, teamIdFor } from "../../src/http/usecases/onboard-team.js";

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

/**
 * Tạo team mới đòi `team:create` — quyền CHỈ org_admin/instance_operator có. Một
 * team_admin bình thường không mở được cửa này (xem test leo thang bên dưới).
 */
const onboard = (over: Record<string, unknown> = {}): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${h.tokens.orgAdminA}` },
    payload: payload(over),
  });

/** Gom message của cả chuỗi `cause` — lỗi DB thật nằm ở tầng dưới lớp bọc drizzle. */
const flattenError = (e: unknown): string => {
  let out = "";
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur instanceof Error; i += 1) {
    out += `${cur.message}\n`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
};

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

  it("baseUrl hỏng ⇒ 400 của TẦNG HỢP ĐỒNG (kể cả scheme lạ), không phải 500", async () => {
    // `z.string().url()` một mình nhận cả ftp:/mailto:/file: — trong khi CHECK của
    // pln_environments chỉ cho http(s). Lệch ấy biến một lỗi input của client thành
    // 500 INTERNAL. Hợp đồng phải chặn CẢ HAI kiểu hỏng ở 400.
    // `idempotencyKey` phải đủ 8 ký tự, nếu không CHÍNH NÓ mới là thứ bị 400 và test
    // lại không nói gì về baseUrl (bẫy của phiên bản trước).
    for (const bad of ["khong-phai-url", "ftp://bad.example.test"]) {
      const r = await onboard({ slug: "team-hong", baseUrl: bad, idempotencyKey: "k-hong-0001" });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    const rows = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-hong'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("lỗi giữa chừng ⇒ rollback TOÀN BỘ (team + user + membership + token + quota)", async () => {
    // Gọi THẲNG use case: chỉ đường này mới mở được transaction rồi chết ở giữa. Đi
    // qua HTTP thì hợp đồng chặn từ trước khi chạm DB — "rollback" kiểu đó không
    // chứng minh được gì.
    const key = "k-rollback-that-su";
    const teamId = teamIdFor(h.ids.orgId, key);
    const err = await onboardTeam(
      { db: h.db.db },
      {
        orgId: h.ids.orgId,
        name: "Team Hỏng",
        slug: "team-hong-that",
        adminEmail: "hong@acme.test",
        baseUrl: "ftp://bad.example.test",
        idempotencyKey: key,
        actorUserId: h.ids.orgAdminUser,
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    // Chết đúng ở CHECK của pln_environments ⇒ team/user/token đã được ghi TRƯỚC đó
    // trong cùng transaction, nên các số 0 dưới đây là rollback thật.
    expect(flattenError(err)).toContain("pln_environments_base_url_check");

    const count = async (sqlText: string, params: unknown[]): Promise<number | undefined> =>
      (await h.db.raw.query<{ n: number }>(sqlText, params)).rows[0]?.n;
    expect(await count(`SELECT count(*)::int AS n FROM teams WHERE id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM api_tokens WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM quota_limits WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM projects WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE email=$1`, ["hong@acme.test"])).toBe(0);
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

  it("thiếu quyền team:create ⇒ 403", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
      payload: payload({ slug: "team-khac", idempotencyKey: "k-author-0001" }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("team_admin THƯỜNG không tạo được team mới — team:manage KHÔNG mở được cửa này", async () => {
    // Leo thang đã tái hiện được trước đây: `team:manage` có ở MỌI team_admin, nên bất
    // kỳ ai cũng tự dựng team rồi tự gắn admin. Tạo team là quyền cấp ORG.
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
      payload: payload({ slug: "team-leo-thang", idempotencyKey: "k-leo-thang" }),
    });
    expect(r.statusCode).toBe(403);
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-leo-thang'`,
    );
    expect(teams.rows[0]?.n).toBe(0);
  });

  it("KHÔNG ép một tài khoản có sẵn vào team mới: adminEmail của người khác ⇒ 409", async () => {
    // Không có bước mời-chấp-nhận ở M2 ⇒ đường an toàn duy nhất là TỪ CHỐI, chứ không
    // phải lặng lẽ gắn membership team_admin cho một người không hề hay biết.
    const r = await onboard({
      adminEmail: "author@acme.test",
      slug: "team-ep-buoc",
      idempotencyKey: "k-ep-buoc",
    });
    expect(r.statusCode).toBe(409);
    const mem = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE user_id=$1`,
      [h.ids.authorUser],
    );
    expect(mem.rows[0]?.n).toBe(1); // vẫn đúng một membership cũ ở team A
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-ep-buoc'`,
    );
    expect(teams.rows[0]?.n).toBe(0);
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
