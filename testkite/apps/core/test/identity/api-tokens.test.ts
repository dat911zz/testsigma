import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { mintTokenSecret } from "../../src/modules/identity/auth/token.js";

let t: TestDb;
let teamA = "";
let teamB = "";
let userId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  const b = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`);
  teamA = String(a.rows[0]?.["id"]);
  teamB = String(b.rows[0]?.["id"]);
  const u = await t.db.execute(sql`INSERT INTO users (email,display_name) VALUES ('qa@acme.test','QA') RETURNING id`);
  userId = String(u.rows[0]?.["id"]);
  await t.db.execute(sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${teamA},${userId},'author')`);
});

async function insertToken(teamId: string, hash: Buffer, prefix: string, expiresInDays = 30): Promise<void> {
  await t.raw.query(
    `INSERT INTO api_tokens (team_id, name, prefix, token_hash, kind, user_id, scopes, expires_at)
     VALUES ($1,'ci',$2,$3,'user_pat',$4,ARRAY['case:read'], now() + ($5 || ' days')::interval)`,
    [teamId, prefix, hash, userId, String(expiresInDays)],
  );
}

describe("api_tokens", () => {
  it("hạn dùng là NOT NULL — không thể tạo token vô hạn", async () => {
    const r = await t.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name='api_tokens' AND column_name='expires_at'`);
    expect(r.rows[0]?.["is_nullable"]).toBe("NO");
  });

  it("token_hash duy nhất toàn cục và có UNIQUE(team_id,id) làm mỏ neo composite FK", async () => {
    const defs = await t.db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE tablename='api_tokens'`);
    const all = defs.rows.map((x) => String(x["indexdef"])).join("\n");
    expect(all).toMatch(/UNIQUE INDEX .*api_tokens_token_hash/);
    expect(all).toMatch(/\(team_id, id\)/);
  });

  it("secret KHÔNG được lưu ở bất kỳ cột nào — chỉ hash và prefix", async () => {
    const cols = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name='api_tokens'`);
    const names = cols.rows.map((x) => String(x["column_name"]));
    expect(names).toContain("token_hash");
    expect(names).toContain("prefix");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("token");
  });

  it("RLS: team B không thấy token của team A", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamB]);
    const seen = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_tokens`);
    await t.raw.exec(`RESET ROLE; RESET app.team_id;`);
    expect(seen.rows[0]?.n).toBe(0);
  });

  it("BẾ TẮC ĐÃ BIẾT: role app KHÔNG tra được token khi chưa biết tenant", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_app`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_tokens WHERE token_hash = $1`, [
      m.tokenHash,
    ]);
    await t.raw.exec(`RESET ROLE`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("role testkite_auth tra được token + membership khi CHƯA có app.team_id", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_auth`);
    const tok = await t.raw.query<{ team_id: string }>(
      `SELECT team_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [m.tokenHash],
    );
    const mem = await t.raw.query<{ role: string }>(`SELECT role FROM memberships WHERE user_id = $1`, [userId]);
    await t.raw.exec(`RESET ROLE`);
    expect(tok.rows[0]?.team_id).toBe(teamA);
    expect(mem.rows[0]?.role).toBe("author");
  });

  it("testkite_auth chỉ ĐỌC được, và chỉ đọc đúng 3 bảng", async () => {
    await t.raw.exec(`SET ROLE testkite_auth`);
    await expect(t.raw.query(`UPDATE api_tokens SET revoked_at = now()`)).rejects.toThrow(/permission denied/i);
    await expect(t.raw.query(`SELECT count(*) FROM teams`)).rejects.toThrow(/permission denied/i);
    await expect(t.raw.query(`SELECT count(*) FROM projects`)).rejects.toThrow(/permission denied/i);
    await t.raw.exec(`RESET ROLE`);
  });

  it("testkite_auth KHÔNG superuser, KHÔNG bypassrls", async () => {
    const r = await t.db.execute(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='testkite_auth'`);
    expect(r.rows[0]?.["rolsuper"]).toBe(false);
    expect(r.rows[0]?.["rolbypassrls"]).toBe(false);
  });
});
