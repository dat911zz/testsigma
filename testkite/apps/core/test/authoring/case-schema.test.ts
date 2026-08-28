import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";

/**
 * drizzle-orm 0.45 WRAPS the driver error: `message` is just "Failed query: <sql>\nparams: …",
 * the constraint name is NOT in there. Measured for real on PGlite 18.3:
 *   - `rejects.toThrow(/aut_cases_status_timeline|check constraint/i)` NEVER goes green;
 *   - `rejects.toThrow(/version/i)` goes FALSELY green — it matches the word "version" in
 *     the SQL statement itself, so it's still green even when the `version` column doesn't exist yet (seen at the RED phase).
 * So assert directly on `cause` (SQLSTATE + constraint name) — the same pattern settled
 * on in M1, see test/schema/tenancy.test.ts.
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
  it("aut_case_status is an enum with exactly 3 states", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_case_status' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["draft", "in_review", "ready"]);
  });

  it("has all 5 workflow timestamps", async () => {
    const r = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'aut_cases' AND column_name LIKE '%_at'`);
    const cols = r.rows.map((x) => String(x["column_name"])).sort();
    expect(cols).toEqual(["created_at", "promoted_at", "reviewed_at", "submitted_at", "updated_at"]);
  });

  it("a new case defaults to draft, version = 1, the three later timestamps NULL", async () => {
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

  it("CHECK blocks status=in_review when submitted_at is NULL", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status)
        VALUES (${teamId}, ${projectId}, 'C2', 'in_review')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_status_timeline");
  });

  it("CHECK blocks status=ready when promoted_at is missing", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, status, submitted_at, reviewed_at)
        VALUES (${teamId}, ${projectId}, 'C3', 'ready', now(), now())`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_status_timeline");
  });

  it("CHECK blocks version <= 0", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_cases (team_id, project_id, name, version)
        VALUES (${teamId}, ${projectId}, 'C4', 0)`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_cases_version_positive");
  });

  it("teams.allow_self_promote defaults to FALSE — four-eyes is on by default, must be turned off BY HAND", async () => {
    const r = await t.db.execute(sql`SELECT allow_self_promote FROM teams WHERE id = ${teamId}`);
    expect(r.rows[0]?.["allow_self_promote"]).toBe(false);
  });
});
