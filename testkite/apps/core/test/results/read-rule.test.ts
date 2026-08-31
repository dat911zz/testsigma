/**
 * THE READ RULE: a run's result is the row with the HIGHEST attempt.
 *
 * An infra retry writes a SECOND set of rows rather than editing the first — a result is
 * evidence, and "attempt 1 died of browser_oom, attempt 2 passed" is exactly what an SRE
 * needs to read afterwards. The price of keeping both is that every product surface must
 * agree on which one it shows, so the rule lives in ONE place: these two functions.
 *
 * Deliberate additions to the plan's block (Task 11, Step 1):
 *  - a `startedAt` carrying MILLISECONDS. The parent's partition key is half of the composite
 *    FK the step rows point at, so anything the write path loses on the way back out is a key
 *    that does not exist and a 23503 on every step.
 *  - the two tenant checks this module cannot go without: another team's run reads back empty,
 *    and a result cannot be attached to another team's job.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  latestCaseResults,
  readStepResults,
  writeCaseResults,
  type CaseResultInput,
} from "../../src/modules/results/results-service.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>", while the Postgres message carrying the constraint name lives in
 * `.cause` (same helper as events.test.ts).
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

const CASE_ONE = "00000000-0000-4000-8000-0000000000c1";
const CASE_TWO = "00000000-0000-4000-8000-0000000000c2";

/** One case with one step, so a test only has to name what it is actually about. */
function caseInput(over: {
  readonly caseId: string;
  readonly chainKey: string;
  readonly verdict: CaseResultInput["verdict"];
  readonly stepVerdict: "passed" | "failed" | "skipped";
  readonly startedAt: Date;
}): CaseResultInput {
  return {
    caseId: over.caseId,
    chainKey: over.chainKey,
    verdict: over.verdict,
    startedAt: over.startedAt,
    finishedAt: new Date(over.startedAt.getTime() + 1_000),
    steps: [
      {
        ordinal: 1,
        execSeq: 1,
        loopPath: [],
        verdict: over.stepVerdict,
        renderedSentence: `Click Login (${over.verdict})`,
        durationMs: 91,
        failureContext: over.stepVerdict === "failed" ? { reason: "browser_oom" } : null,
        screenshotArtifactId: null,
        thumbhash: null,
      },
    ],
  };
}

describe("MAX(attempt) read rule", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;
  let runId = "";
  let jobRunId = "";

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
    const seeded = await t.seedRunWithJobs(a, 1, ["login"]);
    runId = seeded.runId;
    const first = seeded.jobIds[0];
    if (first === undefined) throw new Error("fixture: seedRunWithJobs returned no job");
    jobRunId = first;
  });

  /** attempt 1 = failed (browser_oom), attempt 2 = passed — the retry that flips a verdict. */
  async function writeTwoAttempts(): Promise<void> {
    const base = new Date("2026-08-15T10:00:00.000Z");
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt: 1,
        cases: [
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "failed",
            stepVerdict: "failed",
            startedAt: base,
          }),
        ],
      }),
    );
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt: 2,
        cases: [
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "passed",
            stepVerdict: "passed",
            startedAt: new Date(base.getTime() + 60_000),
          }),
        ],
      }),
    );
  }

  it("returns only the newest attempt for each case, and keeps the older row on disk", async () => {
    await writeTwoAttempts();
    const rows = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    expect(rows.map((r) => ({ attempt: r.attempt, verdict: r.verdict }))).toEqual([
      { attempt: 2, verdict: "passed" },
    ]);
    const all = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM res_case_results`),
    );
    expect(Number(all.rows[0]?.["n"]), "attempt 1 is evidence, it is kept").toBe(2);
  });

  it("reads steps of the newest attempt only", async () => {
    await writeTwoAttempts();
    const [head] = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    if (head === undefined) throw new Error("latestCaseResults returned nothing to read steps of");
    const steps = await t.asTeamCtx(a.teamId, (tx, ctx) => readStepResults(tx, ctx, head.id));
    expect(steps.map((s) => ({ ordinal: s.ordinal, verdict: s.verdict, attempt: s.attempt }))).toEqual([
      { ordinal: 1, verdict: "passed", attempt: 2 },
    ]);
    expect(steps[0]?.failureContext).toBeNull();
    const all = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM res_step_results`),
    );
    expect(Number(all.rows[0]?.["n"]), "the failed attempt's step is still on disk").toBe(2);
  });

  it("does not mix two chains of the same run", async () => {
    const two = await t.seedRunWithJobs(a, 2, ["login", "checkout"]);
    const [loginJob, checkoutJob] = two.jobIds;
    if (loginJob === undefined || checkoutJob === undefined) {
      throw new Error("fixture: seedRunWithJobs returned fewer than two jobs");
    }
    const base = new Date("2026-08-15T10:00:00.000Z");
    // `login` retried and now passes; `checkout` only ever ran once, and failed.
    for (const attempt of [1, 2]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        writeCaseResults(tx, ctx, {
          runId: two.runId,
          jobRunId: loginJob,
          attempt,
          cases: [
            caseInput({
              caseId: CASE_ONE,
              chainKey: "login",
              verdict: attempt === 2 ? "passed" : "failed",
              stepVerdict: attempt === 2 ? "passed" : "failed",
              startedAt: new Date(base.getTime() + attempt * 60_000),
            }),
          ],
        }),
      );
    }
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId: two.runId,
        jobRunId: checkoutJob,
        attempt: 1,
        cases: [
          caseInput({
            caseId: CASE_TWO,
            chainKey: "checkout",
            verdict: "failed",
            stepVerdict: "failed",
            startedAt: base,
          }),
        ],
      }),
    );
    const rows = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, two.runId));
    expect(
      [...rows]
        .map((r) => ({ chainKey: r.chainKey, attempt: r.attempt, verdict: r.verdict }))
        .sort((x, y) => x.chainKey.localeCompare(y.chainKey)),
    ).toEqual([
      { chainKey: "checkout", attempt: 1, verdict: "failed" },
      { chainKey: "login", attempt: 2, verdict: "passed" },
    ]);
  });

  it("keeps the sub-second precision of the parent key the step rows point at", async () => {
    // Every other fixture here starts on a whole second, which is precisely when losing the
    // milliseconds costs nothing. The composite FK carries this timestamp, so if the write
    // path ever narrows it (a `String(date)` round trip prints no milliseconds at all), the
    // step insert fails 23503 against a key the parent row does not have.
    const startedAt = new Date("2026-08-15T10:00:00.123Z");
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt: 1,
        cases: [
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "passed",
            stepVerdict: "passed",
            startedAt,
          }),
        ],
      }),
    );
    const [head] = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    expect(head?.startedAt.toISOString()).toBe("2026-08-15T10:00:00.123Z");
    const steps = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readStepResults(tx, ctx, head?.id ?? ""),
    );
    expect(steps.length).toBe(1);
    expect(steps[0]?.durationMs).toBe(91);
  });

  it("computes the case duration from the timestamps the worker reported", async () => {
    const startedAt = new Date("2026-08-15T10:00:00.000Z");
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt: 1,
        cases: [
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "passed",
            stepVerdict: "passed",
            startedAt,
          }),
        ],
      }),
    );
    const [head] = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    expect(head?.durationMs).toBe(1_000);
    expect(head?.finishedAt?.toISOString()).toBe("2026-08-15T10:00:01.000Z");
  });

  it("writes an attempt ONCE: the second call for the same (job, case, attempt) is a no-op", async () => {
    // The MAX(attempt) rule stands on "one row per (job, case, attempt)". Nothing in the
    // partitioned table can hold that key — a unique constraint there must contain the
    // partition column `started_at`, which the CALLER supplies, so two writes a millisecond
    // apart never collide. `res_case_result_keys` holds it instead, and this is the cheap,
    // sequential half of the proof; the racing half is in
    // test/concurrency/result-attempt-race.test.ts, where it needs real connections.
    const base = new Date("2026-08-15T10:00:00.000Z");
    const write = (verdict: "passed" | "failed", startedAt: Date) =>
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        writeCaseResults(tx, ctx, {
          runId,
          jobRunId,
          attempt: 1,
          cases: [
            caseInput({
              caseId: CASE_ONE,
              chainKey: "login",
              verdict,
              stepVerdict: verdict === "passed" ? "passed" : "failed",
              startedAt,
            }),
          ],
        }),
      );

    expect(await write("passed", base)).toEqual({ written: [CASE_ONE], duplicates: [] });
    // Same attempt, a later clock, a DIFFERENT verdict — the shape a double-dispatch produces.
    expect(await write("failed", new Date(base.getTime() + 1))).toEqual({
      written: [],
      duplicates: [CASE_ONE],
    });

    expect(await t.countRows("res_case_results"), "the second write landed nothing").toBe(1);
    expect(await t.countRows("res_step_results")).toBe(1);
    const rows = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    // First writer wins, and it wins BY THE CLAIM — not because its timestamp sorted highest.
    expect(rows.map((r) => ({ verdict: r.verdict, startedAt: r.startedAt.toISOString() }))).toEqual([
      { verdict: "passed", startedAt: base.toISOString() },
    ]);
  });

  it("refuses a case listed TWICE inside one call, without failing the call", async () => {
    // A payload that names the same case twice is a caller bug, not a reason to lose the
    // whole batch: the claim is taken inside this very transaction, so the second copy
    // conflicts with the first one's own uncommitted key row.
    const base = new Date("2026-08-15T10:00:00.000Z");
    const out = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt: 1,
        cases: [
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "passed",
            stepVerdict: "passed",
            startedAt: base,
          }),
          caseInput({
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "failed",
            stepVerdict: "failed",
            startedAt: new Date(base.getTime() + 1),
          }),
        ],
      }),
    );
    expect(out).toEqual({ written: [CASE_ONE], duplicates: [CASE_ONE] });
    expect(await t.countRows("res_case_results")).toBe(1);
  });

  it("reads another team's run back as nothing — 404, never 403", async () => {
    await writeTwoAttempts();
    const rows = await t.asTeamCtx(b.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    expect(rows).toEqual([]);
  });

  it("refuses to attach a result to another team's job", async () => {
    const foreign = await t.seedRunWithJobs(b, 1, ["login"]);
    const foreignJob = foreign.jobIds[0];
    if (foreignJob === undefined) throw new Error("fixture: seedRunWithJobs returned no job");
    const msg = await rejectionMessage(() =>
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        writeCaseResults(tx, ctx, {
          runId: foreign.runId,
          jobRunId: foreignJob,
          attempt: 1,
          cases: [
            caseInput({
              caseId: CASE_ONE,
              chainKey: "login",
              verdict: "passed",
              stepVerdict: "passed",
              startedAt: new Date("2026-08-15T10:00:00.000Z"),
            }),
          ],
        }),
      ),
    );
    // The refusal now arrives one statement earlier: the idempotency key carries the same
    // composite FK into job_runs, so a foreign job is refused before a result row is attempted.
    expect(msg).toMatch(/res_case_result_keys_job_fk|res_case_results_job_fk|foreign key/i);
    expect(await t.countRows("res_case_results")).toBe(0);
    expect(await t.countRows("res_case_result_keys")).toBe(0);
  });

  it("writes nothing without a tenant context — L1 fail-closed", async () => {
    await expect(
      t.asTeamCtx(a.teamId, (tx) =>
        writeCaseResults(
          tx,
          { teamId: "" },
          {
            runId,
            jobRunId,
            attempt: 1,
            cases: [
              caseInput({
                caseId: CASE_ONE,
                chainKey: "login",
                verdict: "passed",
                stepVerdict: "passed",
                startedAt: new Date("2026-08-15T10:00:00.000Z"),
              }),
            ],
          },
        ),
      ),
    ).rejects.toThrow(/Invalid TenantContext/);
    expect(await t.countRows("res_case_results")).toBe(0);
    // The claim is the FIRST statement of the write path, so fail-closed has to cover it too.
    expect(await t.countRows("res_case_result_keys")).toBe(0);
  });
});
