/**
 * The IDEMPOTENCY of a case result — runs ONLY on REAL Postgres, on several connections.
 *
 * WHY IT CANNOT LIVE IN THE PGlite LAYER: PGlite is a SINGLE wasm connection, so two
 * "concurrent" writers merely queue up and the second one always reads a state the first has
 * already committed. The claim under test is the opposite one — that two writers who reach the
 * same `(job_run_id, case_id, attempt)` at the SAME INSTANT cannot both land a row — and that
 * only means something when both are inside their own transaction at once
 * (see test/harness/realpg.ts).
 *
 * WHY THIS FILE EXISTS AT ALL (measured 2026-08-30, PostgreSQL 16, two independent pools):
 * `res_case_results` is PARTITIONED BY RANGE (started_at), and Postgres refuses a unique
 * constraint on a partitioned table unless the key contains the partition column. So the
 * strongest key `0037_m3_res_results.sql` could declare was
 * UNIQUE (team_id, job_run_id, case_id, attempt, started_at) — and `started_at` is a value the
 * CALLER hands in. Two independent writers of the same attempt differ in it by microseconds,
 * so that constraint NEVER fires: both INSERTs committed, two rows for attempt 1 sat on disk,
 * and `latestCaseResults()` returned whichever one happened to carry the larger clock reading.
 * The last test below still reproduces exactly that, one statement below the fence, so the
 * reason the fence has to exist stays measured rather than remembered.
 *
 * The fence itself is `res_case_result_keys`: NOT partitioned, therefore free to carry the
 * real thing — PRIMARY KEY (team_id, job_run_id, case_id, attempt). `writeCaseResults` claims
 * that key first, in the same transaction as the rows, so the DATABASE (not the order two
 * clocks happen to be in) decides which writer owns an attempt.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is
 * collected.
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

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;

const CASE_ONE = "00000000-0000-4000-8000-0000000000c1";

/** A blocking gate: opens once `n` parties have arrived, so every transaction is OPEN first. */
function makeGate(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

/**
 * Mid-month of the CURRENT month: the migration seeds this month plus the next 13, so a
 * hard-coded month would drop these rows into the default partition once the calendar walked
 * past it — and this file would then be measuring the wrong table.
 */
const BASE_STARTED_AT = ((): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 10, 0, 0, 0));
})();

/** Writer `i` reports its own start time, so the surviving row names the writer that won. */
function startedAtOf(i: number): Date {
  return new Date(BASE_STARTED_AT.getTime() + i);
}

function oneCase(i: number): CaseResultInput {
  return {
    caseId: CASE_ONE,
    chainKey: "login",
    verdict: "passed",
    startedAt: startedAtOf(i),
    finishedAt: new Date(startedAtOf(i).getTime() + 1_000),
    steps: [
      {
        ordinal: 1,
        verdict: "passed",
        renderedSentence: `Click Login (writer ${String(i)})`,
        durationMs: 91,
        failureContext: null,
        screenshotArtifactId: null,
        thumbhash: null,
      },
    ],
  };
}

describeRealPg("case-result attempt under REAL contention (real Postgres, many connections)", () => {
  let r: RealDb;
  let teamId = "";
  let runId = "";
  let jobRunId = "";

  beforeAll(async () => {
    r = await makeRealDb();
    // Open every physical connection BEFORE any race: on a cold pool `Promise.all` is not
    // parallel at all — the second caller pays for TCP + auth and only reaches the table once
    // the first has COMMITted, which is a false green (see promote-lock.test.ts).
    const clients = await Promise.all(Array.from({ length: PARALLEL }, () => r.pool.connect()));
    for (const client of clients) client.release();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE res_step_results, res_case_results, res_case_result_keys, job_runs, orc_run_plans,
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

  const countOf = async (table: "res_case_results" | "res_step_results"): Promise<number> => {
    const rows = await r.db.execute(
      table === "res_case_results"
        ? sql`SELECT count(*)::int n FROM res_case_results`
        : sql`SELECT count(*)::int n FROM res_step_results`,
    );
    return Number(rows.rows[0]?.["n"]);
  };

  it(`${PARALLEL} writers racing on ONE (job, case, attempt): exactly one row lands`, async () => {
    const gate = makeGate(PARALLEL);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_unused, i) =>
        withTenant(r.db, { teamId }, async (tx) => {
          await gate();
          const out = await writeCaseResults(tx, { teamId }, {
            runId,
            jobRunId,
            attempt: 1,
            cases: [oneCase(i)],
          });
          return { i, out };
        }),
      ),
    );

    // ONE writer owns the attempt; the other seven are told so instead of being waved through.
    const winners = results.filter((x) => x.out.written.length === 1);
    expect(winners.length, "exactly one writer may own an attempt").toBe(1);
    const winner = winners[0];
    if (winner === undefined) throw new Error("no writer reported a write");
    for (const loser of results.filter((x) => x !== winner)) {
      expect(loser.out).toEqual({ written: [], duplicates: [CASE_ONE] });
    }

    // And the DB agrees — this is the assertion the old schema failed: it held 8 rows here.
    expect(await countOf("res_case_results")).toBe(1);
    expect(await countOf("res_step_results"), "a loser writes no step rows either").toBe(1);

    const rows = await withTenant(r.db, { teamId }, (tx) =>
      latestCaseResults(tx, { teamId }, runId),
    );
    expect(rows.length).toBe(1);
    // The surviving row belongs to the writer that WON THE CLAIM — not to whichever clock
    // reading happened to be the largest, which is all `started_at DESC` could ever mean.
    expect(rows[0]?.startedAt.toISOString()).toBe(startedAtOf(winner.i).toISOString());
    const head = rows[0];
    if (head === undefined) throw new Error("latestCaseResults returned nothing");
    const steps = await withTenant(r.db, { teamId }, (tx) =>
      latestStepResults(tx, { teamId }, head.id),
    );
    expect(steps.map((s) => s.renderedSentence)).toEqual([
      `Click Login (writer ${String(winner.i)})`,
    ]);
  });

  it("fences per ATTEMPT, so a real retry still writes its own row", async () => {
    // The fence must not turn into "one result per case forever": attempt 2 is exactly how a
    // requeued chain corrects attempt 1, and it is the whole point of the MAX(attempt) rule.
    for (const attempt of [1, 2]) {
      const out = await withTenant(r.db, { teamId }, (tx) =>
        writeCaseResults(tx, { teamId }, {
          runId,
          jobRunId,
          attempt,
          cases: [oneCase(attempt * 1_000)],
        }),
      );
      expect(out, `attempt ${String(attempt)}`).toEqual({ written: [CASE_ONE], duplicates: [] });
    }
    expect(await countOf("res_case_results")).toBe(2);
    const rows = await withTenant(r.db, { teamId }, (tx) =>
      latestCaseResults(tx, { teamId }, runId),
    );
    expect(rows.map((x) => x.attempt)).toEqual([2]);
  });

  it("two writers racing on DIFFERENT cases of one job never block each other out", async () => {
    // The fence is keyed by case, not by job: a chain reporting its cases from two connections
    // must not lose one of them. (Postgres locks the KEY, not the job row.)
    const other = "00000000-0000-4000-8000-0000000000c2";
    const gate = makeGate(2);
    const write = (caseId: string): Promise<{ readonly written: readonly string[] }> =>
      withTenant(r.db, { teamId }, async (tx) => {
        await gate();
        return writeCaseResults(tx, { teamId }, {
          runId,
          jobRunId,
          attempt: 1,
          cases: [{ ...oneCase(1), caseId }],
        });
      });
    const [a, b] = await Promise.all([write(CASE_ONE), write(other)]);
    expect(a.written).toEqual([CASE_ONE]);
    expect(b.written).toEqual([other]);
    expect(await countOf("res_case_results")).toBe(2);
  });

  it("MEASURES why the fence cannot be a UNIQUE constraint on the partitioned table", async () => {
    // Straight INSERTs, no claim: this is the shape `res_case_results_attempt_unique` was
    // supposed to refuse. It does not, and cannot — `started_at` is in the key because the
    // partition key has to be, and the two writers differ in exactly that column.
    const insertRaw = (startedAt: Date): Promise<unknown> =>
      withTenant(r.db, { teamId }, (tx) =>
        tx.execute(sql`
          INSERT INTO res_case_results (team_id, run_id, job_run_id, case_id, chain_key, attempt,
                                        verdict, duration_ms, started_at, finished_at)
          VALUES (${teamId}, ${runId}, ${jobRunId}, ${CASE_ONE}, 'login', 1,
                  'passed', 1000, ${startedAt}, ${new Date(startedAt.getTime() + 1_000)})`),
      );
    await insertRaw(startedAtOf(0));
    // One millisecond later, same team, same job, same case, same attempt: accepted.
    await insertRaw(startedAtOf(1));
    expect(
      await countOf("res_case_results"),
      "23505 was never raised: the unique key contains a caller-supplied timestamp",
    ).toBe(2);
    // ...and the read rule then answers with whichever row carries the larger clock reading,
    // which is the silent wrong verdict the claim in writeCaseResults exists to prevent.
    const rows = await withTenant(r.db, { teamId }, (tx) =>
      latestCaseResults(tx, { teamId }, runId),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.startedAt.toISOString()).toBe(startedAtOf(1).toISOString());
  });
});
