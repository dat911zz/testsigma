import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";

/**
 * drizzle-orm 0.45 BỌC lỗi driver: `message` chỉ là "Failed query: <sql>\nparams: …",
 * tên constraint KHÔNG nằm trong đó. Đo thật trên PGlite 18.3:
 *   - `rejects.toThrow(/aut_cases_status_timeline|check constraint/i)` KHÔNG BAO GIỜ xanh;
 *   - `rejects.toThrow(/version/i)` thì xanh GIẢ — nó khớp chữ "version" trong chính
 *     câu SQL, nên vẫn xanh cả khi cột `version` chưa tồn tại (đã thấy ở pha ĐỎ).
 * Vì vậy khẳng định thẳng vào `cause` (SQLSTATE + tên constraint) — đúng pattern đã
 * chốt ở M1, xem test/schema/tenancy.test.ts.
 */
type PgFailure = { readonly code?: string; readonly constraint?: string };

async function violationOf(p: PromiseLike<unknown>): Promise<PgFailure | undefined> {
  const err: unknown = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { readonly cause?: PgFailure } | undefined)?.cause;
}

/** SQLSTATE 23514 = check_violation. */
const CHECK_VIOLATION = "23514";

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
  const team = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  teamId = String(team.rows[0]?.["id"]);
  const proj = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
  );
  projectId = String(proj.rows[0]?.["id"]);
});

describe("aut_cases — workflow columns", () => {
  it("aut_case_status là enum đúng 3 trạng thái", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_case_status' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["draft", "in_review", "ready"]);
  });

  it("có đủ 5 timestamp workflow", async () => {
    const r = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'aut_cases' AND column_name LIKE '%_at'`);
    const cols = r.rows.map((x) => String(x["column_name"])).sort();
    expect(cols).toEqual(["created_at", "promoted_at", "reviewed_at", "submitted_at", "updated_at"]);
  });

  it("case mới mặc định draft, version = 1, ba timestamp sau NULL", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_cases (team_id, project_id, name) VALUES (${teamId}, ${projectId}, 'C1')
      RETURNING status, version, submitted_at, reviewed_at, promoted_at`);
    const row = r.rows[0];
    expect(row?.["status"]).toBe("draft");
    expect(Number(row?.["version"])).toBe(1);
    expect(row?.["submitted_at"]).toBeNull();
    expect(row?.["reviewed_at"]).toBeNull();
    expect(row?.["promoted_at"]).toBeNull();
  });

  it("CHECK chặn status=in_review khi submitted_at NULL", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status)
        VALUES (${teamId}, ${projectId}, 'C2', 'in_review')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_status_timeline");
  });

  it("CHECK chặn status=ready khi thiếu promoted_at", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status, submitted_at, reviewed_at)
        VALUES (${teamId}, ${projectId}, 'C3', 'ready', now(), now())`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_status_timeline");
  });

  it("CHECK chặn version <= 0", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, version)
        VALUES (${teamId}, ${projectId}, 'C4', 0)`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_version_positive");
  });

  it("teams.allow_self_promote mặc định FALSE — four-eyes bật sẵn, phải TỰ TAY tắt", async () => {
    const r = await t.db.execute(sql`SELECT allow_self_promote FROM teams WHERE id = ${teamId}`);
    expect(r.rows[0]?.["allow_self_promote"]).toBe(false);
  });
});
