/**
 * `res_case_results` / `res_step_results` — two tables partitioned by MONTH.
 *
 * Every assertion below tracks a line that was MEASURED against this very schema in the
 * 2026-08-29 spike (§7), not copied from `audit_events`:
 *  - a unique key on a partitioned table must contain the partition key, or Postgres refuses
 *    the table outright with 0A000 => PRIMARY KEY (team_id, id, started_at);
 *  - a composite FK from one partitioned table into another WORKS, provided it carries the
 *    parent's partition key => res_step_results keeps `case_result_started_at`;
 *  - GRANT BELONGS ON THE PARENT ONLY. Reproduced: after a GRANT SELECT on a child, a team-A
 *    session read all 3 rows of both teams, because a child partition has
 *    relrowsecurity = false and the parent's policy does not reach it;
 *  - with a DEFAULT partition in place an out-of-range row is KEPT rather than rejected (23514).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";

/**
 * The migration seeds the current month plus the next 13, so a HARD-CODED month would turn
 * this suite red the moment the calendar walked out of that window. Both the row and the
 * partition name it is expected to land in are derived from the same month instead.
 */
function monthSuffix(d: Date): string {
  return `${String(d.getUTCFullYear())}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mid-month, mid-day: far enough from either boundary that a server timezone cannot move it. */
function midCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));
}

describe("res_* monthly partitions", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
  });

  it("partitions both result tables by month", async () => {
    const r = await t.db.execute(sql`
      SELECT c.relname, p.partstrat FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname LIKE 'res\\_%'`);
    expect(r.rows.map((x) => String(x["relname"])).sort()).toEqual([
      "res_case_results",
      "res_step_results",
    ]);
    // 'r' = RANGE. LIST or HASH would make "the month partition" a lie.
    for (const row of r.rows) expect(String(row["partstrat"])).toBe("r");
  });

  it("includes the partition key in every unique constraint (Postgres refuses otherwise)", async () => {
    // Spike 2026-08-29: PRIMARY KEY (team_id, id) on a table partitioned by started_at fails
    // with 0A000 "unique constraint on partitioned table must include all partitioning columns".
    const r = await t.db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid IN ('res_case_results'::regclass, 'res_step_results'::regclass)
        AND contype IN ('p','u')`);
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    for (const row of r.rows) {
      expect(String(row["def"]), String(row["conname"])).toContain("started_at");
      // team_id leads every key on a tenant-scoped table — the index behind it is also the
      // one every tenant-scoped read uses.
      expect(String(row["def"]), String(row["conname"])).toMatch(/\((team_id|team_id,)/);
    }
  });

  it("carries the parent's partition key in the step -> case foreign key", async () => {
    // `confrelid = res_case_results` picks the DECLARED constraint: Postgres also clones the
    // FK once per referenced partition (res_case_results_2026_09, ...), and those clones are
    // an implementation detail of how the reference is enforced, not the reference itself.
    const r = await t.db.execute(sql`
      SELECT pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid = 'res_step_results'::regclass AND contype = 'f'
        AND confrelid = 'res_case_results'::regclass`);
    expect(r.rows.map((x) => String(x["def"]))).toEqual([
      "FOREIGN KEY (team_id, case_result_id, case_result_started_at) " +
        "REFERENCES res_case_results(team_id, id, started_at)",
    ]);
  });

  it("grants nothing on a child partition — a child has relrowsecurity = false", async () => {
    // Measured: after GRANT SELECT on the child, a team-A session read all 3 rows including team B's.
    const r = await t.db.execute(sql`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee IN ('testkite_app','testkite_auth','testkite_dispatch')
        AND table_name ~ '^res_(case|step)_results_'`);
    expect(r.rows, "GRANT belongs on the parent only").toEqual([]);
    // Said again from the other side, because a grant inherited from somewhere else would be
    // just as much of a leak as a direct one.
    const priv = await t.db.execute(sql`
      SELECT c.relname,
             has_table_privilege('testkite_app', c.oid, 'SELECT') s,
             has_table_privilege('testkite_app', c.oid, 'INSERT') i
      FROM pg_class c JOIN pg_inherits inh ON inh.inhrelid = c.oid
      JOIN pg_class p ON p.oid = inh.inhparent
      WHERE p.relname IN ('res_case_results','res_step_results')`);
    expect(priv.rows.length).toBeGreaterThan(0);
    for (const row of priv.rows) {
      expect(row["s"], `${String(row["relname"])} was GRANTed SELECT`).toBe(false);
      expect(row["i"], `${String(row["relname"])} was GRANTed INSERT`).toBe(false);
    }
  });

  it("routes a row into the month partition matching started_at", async () => {
    const startedAt = midCurrentMonth();
    await t.seedCaseResult(a, startedAt);
    const r = await t.db.execute(sql`SELECT tableoid::regclass::text t FROM res_case_results`);
    expect(String(r.rows[0]?.["t"])).toBe(`res_case_results_${monthSuffix(startedAt)}`);
  });

  it("keeps an out-of-range row instead of rejecting it (default partition)", async () => {
    await t.seedCaseResult(a, new Date("2019-01-01T00:00:00Z"));
    const r = await t.db.execute(sql`SELECT count(*)::int n FROM res_case_results_default`);
    expect(Number(r.rows[0]?.["n"])).toBe(1);
  });

  it("hides another team's results behind RLS on the parent", async () => {
    await t.seedCaseResult(a, midCurrentMonth());
    const seen = await t.asTeam(b.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM res_case_results`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });

  it("fails closed for the app role with no app.team_id at all", async () => {
    // `RESET app.team_id` leaves an EMPTY STRING behind, so a predicate without NULLIF would
    // throw 22P02 here instead of returning nothing.
    await t.seedCaseResult(a, midCurrentMonth());
    const seen = await t.asAppRoleWithoutTenant((tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM res_case_results`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });

  it("is append-only at the privilege layer: no UPDATE, no DELETE, no TRUNCATE", async () => {
    // A result is EVIDENCE. A later attempt adds a row; nothing ever edits the old one, and
    // the DB is what refuses — not a convention that the code happens never to break.
    for (const table of ["res_case_results", "res_step_results"]) {
      const r = await t.db.execute(sql`
        SELECT has_table_privilege('testkite_app', ${table}, 'SELECT') s,
               has_table_privilege('testkite_app', ${table}, 'INSERT') i,
               has_table_privilege('testkite_app', ${table}, 'UPDATE') u,
               has_table_privilege('testkite_app', ${table}, 'DELETE') d,
               has_table_privilege('testkite_app', ${table}, 'TRUNCATE') tr`);
      expect(r.rows[0], table).toMatchObject({ s: true, i: true, u: false, d: false, tr: false });
    }
  });

  it("keeps ensure_result_partition out of reach of the request-path roles", async () => {
    // It is DDL (CREATE TABLE ... PARTITION OF). A plain CREATE FUNCTION hands EXECUTE to
    // PUBLIC, which would put it on the request path by accident — same fix as 0024 for audit.
    const r = await t.db.execute(sql`
      SELECT has_function_privilege('testkite_app','ensure_result_partition(text,date)','EXECUTE') app,
             has_function_privilege('testkite_auth','ensure_result_partition(text,date)','EXECUTE') auth,
             has_function_privilege('public','ensure_result_partition(text,date)','EXECUTE') pub`);
    expect(r.rows[0]).toMatchObject({ app: false, auth: false, pub: false });
  });

  it("keeps the attempt key in a table that is allowed to hold it — res_case_result_keys", async () => {
    // The constraint one line above is why this table exists: EVERY unique key on
    // res_case_results must contain `started_at`, and `started_at` is a value the caller hands
    // in, so "one row per (job, case, attempt)" is a rule the partitioned table CANNOT state.
    // This one is not partitioned, so it can — and the primary key here says exactly that,
    // with nothing else in it.
    const r = await t.db.execute(sql`
      SELECT pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid = 'res_case_result_keys'::regclass AND contype = 'p'`);
    expect(r.rows.map((x) => String(x["def"]))).toEqual([
      "PRIMARY KEY (team_id, job_run_id, case_id, attempt)",
    ]);
    // A fence with no tenant isolation would be a cross-tenant read of "which attempts exist".
    const rls = await t.db.execute(sql`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'res_case_result_keys'`);
    expect(rls.rows[0]?.["relrowsecurity"]).toBe(true);
    // Append-only like the rows it fences: the app role may claim a key, never release one.
    const priv = await t.db.execute(sql`
      SELECT has_table_privilege('testkite_app', 'res_case_result_keys', 'SELECT') s,
             has_table_privilege('testkite_app', 'res_case_result_keys', 'INSERT') i,
             has_table_privilege('testkite_app', 'res_case_result_keys', 'UPDATE') u,
             has_table_privilege('testkite_app', 'res_case_result_keys', 'DELETE') d,
             has_table_privilege('testkite_app', 'res_case_result_keys', 'TRUNCATE') tr`);
    expect(priv.rows[0]).toMatchObject({ s: true, i: true, u: false, d: false, tr: false });
  });

  it("ties a claimed key to the job it fences: deleting the job takes the key with it", async () => {
    // The key table is a FENCE, not evidence, and it is the one result table with no partition
    // to detach. Its lifetime therefore hangs off the job row: ON DELETE CASCADE is what stops
    // it from being the single table in this module that grows forever.
    const r = await t.db.execute(sql`
      SELECT pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid = 'res_case_result_keys'::regclass AND contype = 'f'`);
    expect(r.rows.map((x) => String(x["def"]))).toEqual([
      "FOREIGN KEY (team_id, job_run_id) REFERENCES job_runs(team_id, id) ON DELETE CASCADE",
    ]);
  });

  it("columns in the hand-written SQL match the drizzle definitions EXACTLY (no drift)", async () => {
    // The DDL is hand-written and the drizzle types are declared separately, so nothing but
    // this test stops the two from quietly disagreeing.
    const { resCaseResults, resStepResults, resCaseResultKeys } = await import(
      "../../src/modules/results/db/results-schema.js"
    );
    for (const [table, def] of [
      ["res_case_results", resCaseResults],
      ["res_step_results", resStepResults],
      ["res_case_result_keys", resCaseResultKeys],
    ] as const) {
      const r = await t.db.execute(sql`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`);
      const inDb = new Set(r.rows.map((x) => String(x["column_name"])));
      const inTs = Object.values(def).flatMap((c) =>
        typeof c === "object" && c !== null && "name" in c
          ? [String((c as { name: string }).name)]
          : [],
      );
      for (const c of inTs) {
        expect([...inDb], `drizzle declares ${table}.${c} but the DB does not have it`).toContain(c);
      }
      expect(inTs.length, `${table}: column count`).toBe(inDb.size);
    }
  });
});
