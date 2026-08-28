import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { STEP_KINDS } from "@testkite/contract";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

/**
 * drizzle-orm 0.45 BỌC lỗi driver: `message` chỉ là "Failed query: <sql>\nparams: …",
 * tên constraint KHÔNG nằm trong đó — nên `rejects.toThrow(/aut_steps_kind_shape/i)`
 * không bao giờ xanh, còn `rejects.toThrow(/unique/i)` thì xanh GIẢ (khớp chữ trong
 * chính câu SQL). Khẳng định thẳng vào `cause` (SQLSTATE + tên constraint) — đúng
 * pattern đã chốt ở M1 (test/schema/tenancy.test.ts) và T2 (case-schema.test.ts).
 */
type PgFailure = { readonly code?: string; readonly constraint?: string };

async function violationOf(p: PromiseLike<unknown>): Promise<PgFailure | undefined> {
  const err: unknown = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { readonly cause?: PgFailure } | undefined)?.cause;
}

/** SQLSTATE: 23514 check_violation, 23505 unique_violation, 23503 foreign_key_violation. */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

let t: TestDb;
let teamId = "";
let otherTeamId = "";
let projectId = "";
let caseId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  const b = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`);
  teamId = String(a.rows[0]?.["id"]);
  otherTeamId = String(b.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const c = await t.db.execute(
    sql`INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamId},${projectId},'C') RETURNING id`,
  );
  caseId = String(c.rows[0]?.["id"]);
});

describe("aut_steps — hình dạng", () => {
  it("enum aut_step_kind khớp CHÍNH XÁC STEP_KINDS của contract", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_step_kind' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual([...STEP_KINDS]);
  });

  it("nhận step action hợp lệ", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','Click on login','click') RETURNING id`);
    expect(String(r.rows[0]?.["id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("CHECK chặn action KHÔNG có verb_op_key", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'action','Click on login')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("CHECK chặn step_group mang verb_op_key (lẫn cột của kind khác)", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, step_group_case_id, verb_op_key)
        VALUES (${teamId},${caseId},1,'step_group','Call login group',${caseId},'click')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("CHECK chặn if KHÔNG có condition_expected", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'if','If previous succeeded')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("nhận for/while/rest — chi tiết nằm ở bảng 1:1, aut_steps chỉ giữ phần chung", async () => {
    for (const [i, kind] of (["for", "while", "rest"] as const).entries()) {
      await t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},${i + 1},${kind},'sentence')`);
    }
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_steps WHERE case_id = ${caseId}`);
    expect(r.rows[0]?.["n"]).toBe(3);
  });

  it("UNIQUE (team_id, case_id, parent_step_id, ordinal) NULLS NOT DISTINCT — hai step gốc cùng ordinal bị chặn", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','s1','click')`);
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
        VALUES (${teamId},${caseId},1,'action','s2','click')`),
    );
    expect(cause?.code).toBe(UNIQUE_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_position_unique");
  });

  it("composite FK chặn step trỏ case của tenant khác", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
        VALUES (${otherTeamId},${caseId},1,'action','s','click')`),
    );
    expect(cause?.code).toBe(FK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_case_fk");
  });

  it("xoá case CASCADE xuống steps", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','s','click')`);
    await t.db.execute(sql`DELETE FROM aut_cases WHERE id = ${caseId}`);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_steps`);
    expect(r.rows[0]?.["n"]).toBe(0);
  });
});

describe("aut_step_loops / aut_rest_steps — 1:1", () => {
  async function mkStep(kind: string): Promise<string> {
    const r = await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
      VALUES (${teamId},${caseId},1,${kind},'sentence') RETURNING id`);
    return String(r.rows[0]?.["id"]);
  }

  it("aut_step_loops UNIQUE theo step — không thể gắn 2 cấu hình vòng lặp cho 1 step", async () => {
    const stepId = await mkStep("for");
    await t.db.execute(sql`
      INSERT INTO aut_step_loops (team_id, step_id, data_profile_id)
      VALUES (${teamId},${stepId},gen_random_uuid())`);
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_step_loops (team_id, step_id, data_profile_id)
        VALUES (${teamId},${stepId},gen_random_uuid())`),
    );
    expect(cause?.code).toBe(UNIQUE_VIOLATION);
    expect(cause?.constraint).toBe("aut_step_loops_step_unique");
  });

  it("aut_rest_steps UNIQUE theo step + CASCADE khi xoá step", async () => {
    const stepId = await mkStep("rest");
    await t.db.execute(sql`
      INSERT INTO aut_rest_steps (team_id, step_id, method, url)
      VALUES (${teamId},${stepId},'POST','https://example.test/api/v1/orders')`);
    await t.db.execute(sql`DELETE FROM aut_steps WHERE id = ${stepId}`);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_rest_steps`);
    expect(r.rows[0]?.["n"]).toBe(0);
  });
});

describe("RLS + GRANT cho 3 bảng step", () => {
  it("cả 3 bảng bật row security", async () => {
    const r = await t.db.execute(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('aut_steps','aut_step_loops','aut_rest_steps') AND relkind='r'`);
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row["relrowsecurity"]).toBe(true);
  });

  it("role app đọc được step của team mình và KHÔNG thấy team khác", async () => {
    await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','mine','click')`);
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
    const mine = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM aut_steps`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [otherTeamId]);
    const theirs = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM aut_steps`);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
    expect(mine.rows[0]?.n).toBe(1);
    expect(theirs.rows[0]?.n).toBe(0);
  });
});
