/**
 * `job_runs` at layer L2/L2.5: the two-role RLS split that a queue needs (the request path
 * sees one tenant, the claim path sees them all), the privileges that keep the dispatch role
 * from ever creating a job, and the three partial indexes the dispatcher/claim/reaper scans
 * were measured against.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>" — the Postgres message carrying the constraint name or the
 * "permission denied" text lives in `.cause`. So `rejects.toThrow(/foreign key/i)` would
 * never match no matter how correct the schema is; walk the whole cause chain instead
 * (same helper as run-schema.test.ts and authoring's L2 tests).
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

describe("job_runs — queue of record", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;
  // Seeded ONCE: the cross-team count below is an assertion about the whole table, so it has
  // to be a fixture the file agrees on, not leftovers from whichever test happened to run first.
  beforeAll(async () => {
    t = await makeTestDb();
    [a, b] = await t.seedTwoTeams();
    await t.seedJobs(a, 3);
    await t.seedJobs(b, 2);
  });
  afterAll(async () => {
    await t.close();
  });

  it("shows the request path only its own team's jobs", async () => {
    const seen = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM job_runs`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(3);
  });

  it("returns nothing at all when app.team_id was never set (fail-closed)", async () => {
    const seen = await t.asAppRoleWithoutTenant((tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM job_runs`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });

  it("lets the dispatch role read across teams — that is the whole point of the claim path", async () => {
    const seen = await t.asDispatchRole((tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM job_runs`),
    );
    expect(Number(seen.rows[0]?.["n"])).toBe(5);
  });

  it("never lets the dispatch role create a job", async () => {
    const msg = await rejectionMessage(() =>
      t.asDispatchRole((tx) =>
        tx.execute(sql`INSERT INTO job_runs (team_id, run_id, chain_key, queue_seq)
          VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 1)`),
      ),
    );
    expect(msg).toMatch(/permission denied/i);
  });

  it("does NOT grant the dispatch role to the app role (permissive policies OR across inherited roles)", async () => {
    // Spike 2026-08-29: granting testkite_dispatch to testkite_app made team A see all 5 rows.
    const r = await t.db.execute(sql`
      SELECT count(*)::int n FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      WHERE granted.rolname = 'testkite_dispatch' AND member.rolname = 'testkite_app'`);
    expect(Number(r.rows[0]?.["n"])).toBe(0);
  });

  it("has one partial index for the dispatcher (no lane) and one for the worker claim (lane first)", async () => {
    const r = await t.db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'job_runs'`,
    );
    const defs = r.rows.map((x) => String(x["indexdef"]));
    // The dispatcher orders by (priority DESC, queue_seq) with no lane filter: an index whose
    // leading column is `lane` is unusable there — measured 10.007ms seq scan vs 0.205ms index scan.
    expect(defs.some((d) => /\(priority DESC, queue_seq\).*WHERE \(status = 'pending'/.test(d))).toBe(
      true,
    );
    expect(
      defs.some((d) => /\(lane, priority DESC, queue_seq\).*WHERE \(status = 'dispatched'/.test(d)),
    ).toBe(true);
    expect(defs.some((d) => /\(lease_expires_at\).*WHERE \(status = 'running'/.test(d))).toBe(true);
  });

  it("cannot attach a job to another team's run", async () => {
    const run = await t.seedRun(a);
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`INSERT INTO job_runs (team_id, run_id, chain_key, queue_seq)
        VALUES (${b.teamId}, ${run}, 'chain-1', nextval('job_runs_queue_seq'))`),
    );
    expect(msg).toMatch(/job_runs_run_fk|foreign key/i);
  });
});
