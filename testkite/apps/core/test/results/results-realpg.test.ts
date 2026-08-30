/**
 * The results write path on the ENGINE THAT HAS AUTHORITY — node-postgres against real
 * PostgreSQL, not the PGlite wasm build.
 *
 * WHY IT CANNOT ONLY LIVE ON PGlite: this is the first schema in the system where a
 * PARTITIONED table carries a composite FK INTO another PARTITIONED table, and where the
 * routing of parent and child into the same month has to hold. The 2026-08-29 spike measured
 * all of that by hand on PostgreSQL 16; nothing re-measures it on every commit unless a test
 * does, and PGlite is a different build of the engine plus a different driver — exactly the
 * pair of things a `FOR VALUES FROM ... TO ...` bound or a cloned FK could differ on.
 *
 * The millisecond assertion is here for the same reason: both drivers happen to hand
 * drizzle's `execute()` a STRING for timestamptz today (measured 2026-08-30), so the PGlite
 * layer cannot tell a driver-independent write path from one that only works by luck; this
 * layer is where the composite key is checked against the real planner and the real types.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import {
  latestCaseResults,
  latestStepResults,
  writeCaseResults,
  type CaseResultInput,
} from "../../src/modules/results/results-service.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

const CASE_ONE = "00000000-0000-4000-8000-0000000000c1";

/**
 * Mid-month of the CURRENT month, carrying milliseconds a whole-second fixture would never
 * notice going missing. The month is computed rather than written down because the migration
 * seeds the current month plus 13 — a literal month would put the row in the default
 * partition, and this suite red, as soon as the calendar walked past it.
 */
const STARTED_AT = ((): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 10, 0, 0, 123));
})();

function monthSuffix(d: Date): string {
  return `${String(d.getUTCFullYear())}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

describeRealPg("results on real Postgres (node-postgres types)", () => {
  let r: RealDb;
  let teamId = "";
  let runId = "";
  let jobRunId = "";

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE res_step_results, res_case_results, job_runs, orc_run_plans,
               orc_compile_diagnostics, orc_runs, quota_limits, memberships, projects,
               teams, users, organizations
      RESTART IDENTITY CASCADE`);
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const rows = await r.db.execute(query);
      const id: unknown = rows.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
      return id;
    };
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    teamId = await one(
      sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId},'A','a') RETURNING id`,
    );
    const projectId = await one(
      sql`INSERT INTO projects (team_id, name, slug) VALUES (${teamId},'P','p') RETURNING id`,
    );
    const userId = await one(
      sql`INSERT INTO users (email, display_name) VALUES ('a@testkite.test','A') RETURNING id`,
    );
    runId = await one(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${teamId}, ${projectId}, 'batch', ${userId}, 'ready') RETURNING id`);
    jobRunId = await one(sql`
      INSERT INTO job_runs (team_id, run_id, chain_key) VALUES (${teamId}, ${runId}, 'login')
      RETURNING id`);
  });

  const oneCase = (verdict: "passed" | "failed", startedAt: Date): CaseResultInput => ({
    caseId: CASE_ONE,
    chainKey: "login",
    verdict,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1_000),
    steps: [
      {
        ordinal: 1,
        verdict,
        renderedSentence: "Click Login",
        durationMs: 91,
        failureContext: verdict === "failed" ? { reason: "browser_oom" } : null,
        screenshotArtifactId: null,
        thumbhash: null,
      },
    ],
  });

  it("writes a case and its steps with the milliseconds intact", async () => {
    await withTenant(r.db, { teamId }, (tx) =>
      writeCaseResults(tx, { teamId }, {
        runId,
        jobRunId,
        attempt: 1,
        cases: [oneCase("passed", STARTED_AT)],
      }),
    );
    const rows = await withTenant(r.db, { teamId }, (tx) =>
      latestCaseResults(tx, { teamId }, runId),
    );
    expect(rows.map((x) => x.startedAt.toISOString())).toEqual([STARTED_AT.toISOString()]);
    const head = rows[0];
    if (head === undefined) throw new Error("latestCaseResults returned nothing");
    const steps = await withTenant(r.db, { teamId }, (tx) =>
      latestStepResults(tx, { teamId }, head.id),
    );
    // The step exists at all only because its FK key matched to the millisecond.
    expect(steps.map((s) => ({ ordinal: s.ordinal, verdict: s.verdict }))).toEqual([
      { ordinal: 1, verdict: "passed" },
    ]);
    // Parent and children share the partition key, so retention detaches them as one month.
    const where = await r.db.execute(sql`
      SELECT (SELECT tableoid::regclass::text FROM res_case_results) c,
             (SELECT tableoid::regclass::text FROM res_step_results) s`);
    expect(String(where.rows[0]?.["c"])).toBe(`res_case_results_${monthSuffix(STARTED_AT)}`);
    expect(String(where.rows[0]?.["s"])).toBe(`res_step_results_${monthSuffix(STARTED_AT)}`);
  });

  it("reads back the newest attempt only, with the failed one still on disk", async () => {
    for (const [attempt, verdict] of [
      [1, "failed"],
      [2, "passed"],
    ] as const) {
      await withTenant(r.db, { teamId }, (tx) =>
        writeCaseResults(tx, { teamId }, {
          runId,
          jobRunId,
          attempt,
          cases: [oneCase(verdict, new Date(STARTED_AT.getTime() + attempt * 60_000))],
        }),
      );
    }
    const rows = await withTenant(r.db, { teamId }, (tx) =>
      latestCaseResults(tx, { teamId }, runId),
    );
    expect(rows.map((x) => ({ attempt: x.attempt, verdict: x.verdict }))).toEqual([
      { attempt: 2, verdict: "passed" },
    ]);
    const all = await r.db.execute(sql`SELECT count(*)::int n FROM res_case_results`);
    expect(Number(all.rows[0]?.["n"])).toBe(2);
  });
});
