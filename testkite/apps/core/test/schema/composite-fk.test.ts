import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamA = "";
let teamB = "";
let projA = "";
let projB = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(
    sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`,
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
  const pa = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa') RETURNING id`,
  );
  const pb = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamB},'PB','pb') RETURNING id`,
  );
  projA = String(pa.rows[0]?.["id"]);
  projB = String(pb.rows[0]?.["id"]);
});

/**
 * drizzle-orm 0.45 bọc lỗi driver trong `DrizzleQueryError`: `.message` chỉ là
 * "Failed query: <sql>" còn lỗi Postgres thật — kèm TÊN CONSTRAINT — nằm ở `.cause`.
 * Test L2 phải soi đúng tên constraint (không chỉ "có ném lỗi"), nên gom cả chuỗi cause.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: unknown) {
    const parts: string[] = [];
    let cur: unknown = err;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    return parts.join(" | ");
  }
  throw new Error("query đáng lẽ phải bị Postgres từ chối, nhưng nó chạy thành công");
}

describe("composite FK (L2)", () => {
  it("ghi hợp lệ trong cùng tenant thì OK", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamA},${projA},'login') RETURNING id`);
    expect(String(r.rows[0]?.["id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("case của team A trỏ project của team B ⇒ CHẾT tại Postgres, không cần app check", async () => {
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamA},${projB},'evil')`),
    );
    expect(msg).toMatch(/aut_cases_project_fk|foreign key/i);
  });

  it("prereq trỏ case của team khác ⇒ CHẾT tại composite self-FK", async () => {
    const b = await t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamB},${projB},'b-case') RETURNING id`);
    const bCase = String(b.rows[0]?.["id"]);
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, prereq_case_id)
        VALUES (${teamA},${projA},'a-case',${bCase})`),
    );
    expect(msg).toMatch(/aut_cases_prereq_fk|foreign key/i);
  });

  it("prereq cùng tenant thì OK", async () => {
    const p = await t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamA},${projA},'login') RETURNING id`);
    const login = String(p.rows[0]?.["id"]);
    await expect(
      t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name, prereq_case_id)
      VALUES (${teamA},${projA},'checkout',${login})`),
    ).resolves.toBeDefined();
  });

  it("FK khai báo đúng dạng composite (team_id đi kèm), không phải FK cột đơn", async () => {
    const r = await t.db.execute(sql`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t2 ON t2.oid = c.conrelid
      WHERE t2.relname='aut_cases' AND c.contype='f'`);
    const defs = r.rows.map((x) => String(x["def"]));
    expect(
      defs.some((d) =>
        /FOREIGN KEY \(team_id, project_id\) REFERENCES projects\(team_id, id\)/.test(d),
      ),
    ).toBe(true);
    expect(
      defs.some((d) =>
        /FOREIGN KEY \(team_id, prereq_case_id\) REFERENCES aut_cases\(team_id, id\)/.test(d),
      ),
    ).toBe(true);
  });

  it("aut_cases cũng bật RLS (L2.5 chồng lên L2)", async () => {
    const r = await t.db.execute(sql`
      SELECT relrowsecurity FROM pg_class WHERE relname='aut_cases' AND relkind='r'`);
    expect(r.rows[0]?.["relrowsecurity"]).toBe(true);
  });
});
