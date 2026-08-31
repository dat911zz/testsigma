/**
 * The read path used to hide the problem instead of the write path preventing it:
 * `SELECT DISTINCT ON (step_ordinal)` collapsed every repeat of an ordinal into one row, so a
 * 3-row `for` reported ONE step and an inlined step group lost a step with no error anywhere.
 * These tests state the replacement: the write path refuses a duplicate identity, and the read
 * path returns everything, in execution order.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  latestCaseResults,
  readStepResults,
  writeCaseResults,
  type StepResultInput,
  type StepResultRow,
} from "../../src/modules/results/results-service.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>", while the Postgres message carrying the constraint name lives in
 * `.cause` (same helper as read-rule.test.ts).
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
  throw new Error("the write was expected to be rejected, but it succeeded");
}

const CASE_ONE = "00000000-0000-4000-8000-0000000000c1";
const STARTED_AT = new Date("2026-08-15T10:00:00.000Z");

/** The identity half of a step row; everything else is scenery this file does not care about. */
interface Identity {
  readonly ordinal: number;
  readonly execSeq: number;
  readonly loopPath: readonly number[] | null;
  readonly verdict?: StepResultInput["verdict"];
  readonly failureContext?: Readonly<Record<string, unknown>>;
}

function stepInput(id: Identity): StepResultInput {
  return {
    ordinal: id.ordinal,
    execSeq: id.execSeq,
    loopPath: id.loopPath,
    verdict: id.verdict ?? "passed",
    renderedSentence: "Type $data:user",
    durationMs: 10,
    failureContext: id.failureContext ?? null,
    screenshotArtifactId: null,
    thumbhash: null,
  };
}

describe("res_step_results identity", () => {
  let t: TestDb;
  let a: SeededTeam;
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
    [a] = await t.seedTwoTeams();
    const seeded = await t.seedRunWithJobs(a, 1, ["login"]);
    runId = seeded.runId;
    const first = seeded.jobIds[0];
    if (first === undefined) throw new Error("fixture: seedRunWithJobs returned no job");
    jobRunId = first;
  });

  async function write(steps: readonly StepResultInput[], attempt = 1): Promise<void> {
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      writeCaseResults(tx, ctx, {
        runId,
        jobRunId,
        attempt,
        cases: [
          {
            caseId: CASE_ONE,
            chainKey: "login",
            verdict: "passed",
            startedAt: STARTED_AT,
            finishedAt: new Date(STARTED_AT.getTime() + 1_000),
            steps,
          },
        ],
      }),
    );
  }

  async function readBack(): Promise<readonly StepResultRow[]> {
    const [head] = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    if (head === undefined) throw new Error("latestCaseResults returned nothing");
    return t.asTeamCtx(a.teamId, (tx, ctx) => readStepResults(tx, ctx, head.id));
  }

  async function writeThenRead(ids: readonly Identity[]): Promise<readonly StepResultRow[]> {
    await write(ids.map(stepInput));
    return readBack();
  }

  it("keeps all three executions of a 3-row `for`", async () => {
    const steps = await writeThenRead([
      { ordinal: 2, execSeq: 1, loopPath: [1] },
      { ordinal: 2, execSeq: 2, loopPath: [2] },
      { ordinal: 2, execSeq: 3, loopPath: [3], verdict: "failed", failureContext: { message: "row 3" } },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.loopPath)).toEqual([[1], [2], [3]]);
    expect(steps.map((s) => s.verdict)).toEqual(["passed", "passed", "failed"]);
  });

  it("returns steps in EXECUTION order, not ordinal order", async () => {
    // a `for` at ordinal 5 whose body is ordinals 6 and 7, run twice: 6,7,6,7 — never 6,6,7,7
    const steps = await writeThenRead([
      { ordinal: 6, execSeq: 1, loopPath: [1] },
      { ordinal: 7, execSeq: 2, loopPath: [1] },
      { ordinal: 6, execSeq: 3, loopPath: [2] },
      { ordinal: 7, execSeq: 4, loopPath: [2] },
    ]);
    expect(steps.map((s) => s.ordinal)).toEqual([6, 7, 6, 7]);
    expect(steps.map((s) => s.execSeq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps two steps of one case that share an ordinal (inlined step group)", async () => {
    const steps = await writeThenRead([
      { ordinal: 1, execSeq: 1, loopPath: [] },
      { ordinal: 2, execSeq: 2, loopPath: [] },
      { ordinal: 3, execSeq: 3, loopPath: [] },
      { ordinal: 2, execSeq: 4, loopPath: [] },
    ]);
    expect(steps.map((s) => s.ordinal)).toEqual([1, 2, 3, 2]);
  });

  it("refuses a second row with the same execSeq inside one case attempt", async () => {
    // The invariant moved from the read path to the write path: the database, not a DISTINCT ON.
    const msg = await rejectionMessage(() =>
      writeThenRead([
        { ordinal: 1, execSeq: 1, loopPath: [] },
        { ordinal: 9, execSeq: 1, loopPath: [] },
      ]),
    );
    expect(msg).toMatch(/res_step_results_exec_unique|duplicate key/i);
  });

  it("stores a null loopPath as unknown, distinct from an empty one", async () => {
    const steps = await writeThenRead([
      { ordinal: 1, execSeq: 1, loopPath: null },
      { ordinal: 2, execSeq: 2, loopPath: [] },
    ]);
    expect(steps[0]?.loopPath).toBeNull();
    expect(steps[1]?.loopPath).toEqual([]);
  });

  it("lets the SAME execSeq live in two attempts of one case — a retry is a new parent row", async () => {
    await write([stepInput({ ordinal: 1, execSeq: 1, loopPath: [] })], 1);
    await write([stepInput({ ordinal: 1, execSeq: 1, loopPath: [] })], 2);
    const steps = await readBack();
    expect(steps.map((s) => s.attempt)).toEqual([2]);
    const all = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT count(*)::int n FROM res_step_results`),
    );
    expect(Number(all.rows[0]?.["n"]), "attempt 1 is evidence, it is kept").toBe(2);
  });

  it("stores a loop path deep enough for a realistic nest, and reads it back in order", async () => {
    const steps = await writeThenRead([{ ordinal: 4, execSeq: 1, loopPath: [3, 1, 2] }]);
    expect(steps[0]?.loopPath).toEqual([3, 1, 2]);
  });
});
