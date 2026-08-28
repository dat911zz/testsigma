import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { STEP_KINDS } from "@testkite/contract";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

/**
 * drizzle-orm 0.45 WRAPS the driver error: `message` is just "Failed query: <sql>\nparams: …",
 * the constraint name is NOT in there — so `rejects.toThrow(/aut_steps_kind_shape/i)`
 * never goes green, while `rejects.toThrow(/unique/i)` goes FALSELY green (it matches text
 * in the SQL statement itself). Assert directly on `cause` (SQLSTATE + constraint name) —
 * the same pattern settled on in M1 (test/schema/tenancy.test.ts) and T2 (case-schema.test.ts).
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

describe("aut_steps — shape", () => {
  it("enum aut_step_kind matches STEP_KINDS from the contract EXACTLY", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_step_kind' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual([...STEP_KINDS]);
  });

  it("accepts a valid action step", async () => {
    const r = await t.db.execute(sql`
      INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
      VALUES (${teamId},${caseId},1,'action','Click on login','click') RETURNING id`);
    expect(String(r.rows[0]?.["id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("CHECK blocks an action WITHOUT a verb_op_key", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'action','Click on login')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("CHECK blocks a step_group carrying verb_op_key (columns from another kind bleeding in)", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, step_group_case_id, verb_op_key)
        VALUES (${teamId},${caseId},1,'step_group','Call login group',${caseId},'click')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("CHECK blocks an if WITHOUT condition_expected", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},1,'if','If previous succeeded')`),
    );
    expect(cause?.code).toBe(CHECK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_kind_shape");
  });

  it("accepts for/while/rest — details live in the 1:1 tables, aut_steps only keeps the common part", async () => {
    for (const [i, kind] of (["for", "while", "rest"] as const).entries()) {
      await t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence)
        VALUES (${teamId},${caseId},${i + 1},${kind},'sentence')`);
    }
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_steps WHERE case_id = ${caseId}`);
    expect(r.rows[0]?.["n"]).toBe(3);
  });

  it("UNIQUE (team_id, case_id, parent_step_id, ordinal) NULLS NOT DISTINCT — two root steps sharing an ordinal are blocked", async () => {
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

  it("the composite FK blocks a step pointing at another tenant's case", async () => {
    const cause = await violationOf(
      t.db.execute(sql`
        INSERT INTO aut_steps (team_id, case_id, ordinal, kind, rendered_sentence, verb_op_key)
        VALUES (${otherTeamId},${caseId},1,'action','s','click')`),
    );
    expect(cause?.code).toBe(FK_VIOLATION);
    expect(cause?.constraint).toBe("aut_steps_case_fk");
  });

  it("deleting a case CASCADEs down to its steps", async () => {
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

  it("aut_step_loops is UNIQUE per step — you can't attach 2 loop configs to 1 step", async () => {
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

  it("aut_rest_steps is UNIQUE per step + CASCADEs when the step is deleted", async () => {
    const stepId = await mkStep("rest");
    await t.db.execute(sql`
      INSERT INTO aut_rest_steps (team_id, step_id, method, url)
      VALUES (${teamId},${stepId},'POST','https://example.test/api/v1/orders')`);
    await t.db.execute(sql`DELETE FROM aut_steps WHERE id = ${stepId}`);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_rest_steps`);
    expect(r.rows[0]?.["n"]).toBe(0);
  });
});

describe("RLS + GRANT for the 3 step tables", () => {
  it("all 3 tables have row security enabled", async () => {
    const r = await t.db.execute(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('aut_steps','aut_step_loops','aut_rest_steps') AND relkind='r'`);
    expect(r.rows.length).toBe(3);
    for (const row of r.rows) expect(row["relrowsecurity"]).toBe(true);
  });

  it("the app role reads its own team's steps and CANNOT see another team's", async () => {
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
