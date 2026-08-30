/**
 * The run aggregate at layer L2/L2.5: shape of the tables, the composite FK, RLS, and the
 * privilege that makes a frozen plan append-only.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>" — the Postgres message carrying the constraint name lives in
 * `.cause`. So `rejects.toThrow(/foreign key/i)` would never match no matter how correct
 * the schema is; walk the whole cause chain instead (same helper as authoring's L2 tests).
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
  throw new Error("query was expected to be rejected by Postgres, but it succeeded");
}

describe("orc_runs / orc_run_plans / orc_compile_diagnostics", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps team_id leading on every index and UNIQUE(team_id, id) on every table", async () => {
    const r = await t.db.execute(sql`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE tablename IN ('orc_runs','orc_run_plans','orc_compile_diagnostics')`);
    const defs = r.rows.map((row) => String(row["indexdef"]));
    for (const table of ["orc_runs", "orc_run_plans", "orc_compile_diagnostics"]) {
      expect(
        defs.some((d) => d.includes(`ON public.${table}`) && /\(team_id, id\)/.test(d)),
        `${table} is missing UNIQUE(team_id, id)`,
      ).toBe(true);
    }
    // A btree index that does not start with team_id makes a cross-tenant scan cheap.
    const nonLeading = defs.filter((d) => /USING btree \((?!team_id)/.test(d) && !d.includes("_pkey"));
    expect(nonLeading, "every btree index must lead with team_id").toEqual([]);
  });

  it("refuses a run plan that points at another team's run (composite FK, layer L2)", async () => {
    const [a, b] = await t.seedTwoTeams();
    const run = await t.db.execute(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${a.teamId}, ${a.projectId}, 'batch', ${a.userId}, 'ready') RETURNING id`);
    const runId = String(run.rows[0]?.["id"]);
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`
        INSERT INTO orc_run_plans (team_id, run_id, content_hash, plan_format_version, plan)
        VALUES (${b.teamId}, ${runId}, ${"0".repeat(64)}, 1, '{}'::jsonb)`),
    );
    expect(msg).toMatch(/orc_run_plans_run_fk|foreign key/i);
  });

  it("hides another team's run behind RLS instead of returning 403 material", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.db.execute(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${a.teamId}, ${a.projectId}, 'batch', ${a.userId}, 'ready')`);
    const seenByB = await t.asTeam(b.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_runs`));
    expect(Number(seenByB.rows[0]?.["n"])).toBe(0);
  });

  it("keeps a frozen plan immutable: the app role has no UPDATE or DELETE on orc_run_plans", async () => {
    const r = await t.db.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'orc_run_plans' AND grantee = 'testkite_app' ORDER BY privilege_type`);
    expect(r.rows.map((x) => String(x["privilege_type"]))).toEqual(["INSERT", "SELECT"]);
  });
});
