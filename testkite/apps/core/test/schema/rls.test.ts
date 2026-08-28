import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { APP_ROLE, AUTH_ROLE } from "../../src/modules/kernel/index.js";

let t: TestDb;
let teamA = "";
let teamB = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(
    sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
  );
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  const b = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`,
  );
  teamA = String(a.rows[0]?.["id"]);
  teamB = String(b.rows[0]?.["id"]);
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa')`);
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamB},'PB','pb')`);
});

/** Chạy một khối SQL đúng như request-path thật: role app + app.team_id. */
async function asTeam<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  await t.raw.exec(`SET ROLE testkite_app`);
  await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
  try {
    return await fn();
  } finally {
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
  }
}

describe("RLS L2.5", () => {
  it("role testkite_app KHÔNG superuser và KHÔNG bypassrls", async () => {
    const r = await t.db.execute(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'testkite_app'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.["rolsuper"]).toBe(false);
    expect(r.rows[0]?.["rolbypassrls"]).toBe(false);
  });

  it("mọi bảng tenant-scoped bật row security", async () => {
    const r = await t.db.execute(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('teams','projects','memberships') AND relkind='r'`);
    for (const row of r.rows) expect(row["relrowsecurity"]).toBe(true);
    expect(r.rows.length).toBe(3);
  });

  it("SELECT chỉ thấy row của team trong app.team_id", async () => {
    const namesA = await asTeam(teamA, async () =>
      (
        await t.raw.query<{ name: string }>(`SELECT name FROM projects ORDER BY name`)
      ).rows.map((x) => x.name),
    );
    const namesB = await asTeam(teamB, async () =>
      (
        await t.raw.query<{ name: string }>(`SELECT name FROM projects ORDER BY name`)
      ).rows.map((x) => x.name),
    );
    expect(namesA).toEqual(["PA"]);
    expect(namesB).toEqual(["PB"]);
  });

  it("KHÔNG set app.team_id ⇒ 0 row (fail-closed), không ném lỗi", async () => {
    await t.raw.exec(`SET ROLE testkite_app`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`);
    await t.raw.exec(`RESET ROLE`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("app.team_id = '' (dạng RESET để lại) ⇒ 0 row, KHÔNG lỗi 22P02", async () => {
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', '', false)`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("WITH CHECK chặn INSERT sang team khác", async () => {
    await expect(
      asTeam(teamA, () =>
        t.raw.query(`INSERT INTO projects (team_id,name,slug) VALUES ($1,'evil','evil')`, [teamB]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("UPDATE/DELETE row team khác ảnh hưởng 0 row (vô hình, không 403)", async () => {
    const upd = await asTeam(teamA, () =>
      t.raw.query(`UPDATE projects SET name='hacked' WHERE team_id=$1 RETURNING id`, [teamB]),
    );
    expect(upd.rows.length).toBe(0);
    const del = await asTeam(teamA, () =>
      t.raw.query(`DELETE FROM projects WHERE team_id=$1 RETURNING id`, [teamB]),
    );
    expect(del.rows.length).toBe(0);
  });

  it("policy dùng NULLIF — không có policy nào cast thẳng current_setting", async () => {
    const r = await t.db.execute(sql`
      SELECT policyname, qual, roles::text AS roles, cmd, with_check FROM pg_policies WHERE schemaname='public'`);
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    let tenantPolicies = 0;
    for (const row of r.rows) {
      const roles = String(row["roles"]);
      // Vị từ tenant CHỈ ràng buộc policy của đường request (testkite_app): đó là chỗ
      // `''::uuid` sẽ ném 22P02 thay vì fail-closed nếu quên NULLIF.
      if (roles.includes(APP_ROLE)) {
        tenantPolicies += 1;
        expect(String(row["qual"]), `policy ${String(row["policyname"])} thiếu NULLIF`).toContain("NULLIF");
        continue;
      }
      // Ngoại lệ DUY NHẤT được phép, và bị ghim chặt: policy `auth_lookup` của đường
      // xác thực (spike 2026-08-28) — nó USING (true) vì lúc tra token còn CHƯA biết
      // tenant. Đổi lại nó phải chỉ thuộc testkite_auth, chỉ SELECT, và không
      // with_check (⇒ không ghi được gì).
      expect(String(row["policyname"])).toBe("auth_lookup");
      expect(roles).toBe(`{${AUTH_ROLE}}`);
      expect(String(row["cmd"])).toBe("SELECT");
      expect(row["with_check"]).toBeNull();
    }
    expect(tenantPolicies).toBeGreaterThanOrEqual(3);
  });
});
