/**
 * The fleet upgrades on its own schedule; the control plane does not get to 400 a worker for
 * being one release behind. But "be lenient" must not mean "invent data": the reconstruction
 * below is EXACT, not a comfort default — apps/runner appends outcomes in emission order and
 * maps that array straight into `steps`, so index+1 IS the execSeq a new worker would send
 * (pinned from the other side by apps/runner/test/executor/step-identity.test.ts, "keeps
 * execSeq equal to the outcome's own position in the reported array").
 *
 * DELIBERATE DEVIATION from the plan's block: the plan put an SSE-frame assertion in this file
 * (`h.readStream`). The internal plane serves `/internal/fleet` only — `GET /v1/runs/{id}/stream`
 * belongs to the public app, built on a DIFFERENT PGlite instance by a different harness — so
 * that half is asserted where the stream actually exists (test/orchestration/sse.test.ts,
 * "carries a step's execution identity into the SSE frame"). What is provable HERE is the other
 * link of the same chain: the plane stores the identity in the event payload, verbatim.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeInternalTestApp,
  makeInternalTestApp,
  type ClaimedJobBody,
  type InternalTestApp,
} from "../../harness/internal.js";

/** One step of a `complete` body, as a worker builds it. */
type WireStep = Readonly<Record<string, unknown>>;

describe("POST /internal/fleet/jobs/{jobRunId}/complete — step identity", () => {
  let h: InternalTestApp;
  let job: ClaimedJobBody;
  let caseId = "";

  beforeEach(async () => {
    h = await makeInternalTestApp();
    job = await h.claimOneJob();
    caseId = h.sampleStep().caseId;
  });
  afterAll(async () => {
    await closeInternalTestApp();
  });

  const complete = async (steps: readonly WireStep[]): ReturnType<InternalTestApp["post"]> =>
    h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      { leaseEpoch: job.leaseEpoch, verdict: "passed", steps, artifacts: [] },
      job.runToken,
    );

  it("accepts a worker that sends no execSeq and reconstructs it from array order", async () => {
    const res = await complete([
      { caseId, ordinal: 2, status: "passed", durationMs: 10 },
      { caseId, ordinal: 2, status: "passed", durationMs: 11 },
      { caseId, ordinal: 2, status: "passed", durationMs: 12 },
    ]);
    expect(res.statusCode).toBe(200);
    const steps = await h.readSteps(caseId);
    expect(steps.map((s) => s.execSeq)).toEqual([1, 2, 3]);
    // unknown, NOT "[]": an old worker never claimed its step ran outside a loop.
    expect(steps.map((s) => s.loopPath)).toEqual([null, null, null]);
  });

  it("stores what a current worker sends, verbatim", async () => {
    // THE PAYLOAD BELOW IS THE OUTPUT OF apps/runner/test/executor/step-identity.test.ts,
    // "gives a 3-row `for` three distinct executions of the same ordinal", after #completedSteps.
    // Changing one side without the other must break this test, which is the point of copying it.
    const res = await complete([
      { caseId, ordinal: 2, execSeq: 1, loopPath: [1], status: "passed", durationMs: 10, renderedSentence: "Type $data:user" },
      { caseId, ordinal: 2, execSeq: 2, loopPath: [2], status: "passed", durationMs: 11, renderedSentence: "Type $data:user" },
      { caseId, ordinal: 2, execSeq: 3, loopPath: [3], status: "passed", durationMs: 12, renderedSentence: "Type $data:user" },
    ]);
    expect(res.statusCode).toBe(200);
    const steps = await h.readSteps(caseId);
    expect(steps.map((s) => [s.execSeq, s.loopPath])).toEqual([
      [1, [1]],
      [2, [2]],
      [3, [3]],
    ]);
  });

  it("refuses a steps array that carries execSeq on only SOME entries", async () => {
    // Not a version skew — a worker that numbers half its steps is broken, and reconstructing
    // the other half would interleave two numbering schemes into one silent mess.
    const res = await complete([
      { caseId, ordinal: 1, execSeq: 1, status: "passed", durationMs: 1 },
      { caseId, ordinal: 2, status: "passed", durationMs: 1 },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a repeated execSeq before it ever reaches the database", async () => {
    const res = await complete([
      { caseId, ordinal: 1, execSeq: 1, status: "passed", durationMs: 1 },
      { caseId, ordinal: 2, execSeq: 1, status: "passed", durationMs: 1 },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await h.caseResultCount(job.jobRunId), "nothing was written").toBe(0);
  });

  it("refuses a loopPath deeper than the contract's ceiling", async () => {
    const res = await complete([
      {
        caseId,
        ordinal: 1,
        execSeq: 1,
        loopPath: Array.from({ length: 17 }, () => 1),
        status: "passed",
        durationMs: 1,
      },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it("refuses an execSeq that is not a 1-based integer", async () => {
    for (const execSeq of [0, -1, 1.5]) {
      const res = await complete([{ caseId, ordinal: 1, execSeq, status: "passed", durationMs: 1 }]);
      expect(res.statusCode, `execSeq ${String(execSeq)}`).toBe(400);
    }
  });

  it("keeps the identity of a `for` whose two cases share one report", async () => {
    // Two cases in ONE complete: the numbering is chain-wide, so the second case's steps carry
    // execSeq 3 and 4 — and grouping by caseId must not renumber them.
    const other = "00000000-0000-4000-8000-0000000000c9";
    const res = await complete([
      { caseId, ordinal: 1, execSeq: 1, loopPath: [1], status: "passed", durationMs: 1 },
      { caseId, ordinal: 1, execSeq: 2, loopPath: [2], status: "passed", durationMs: 1 },
      { caseId: other, ordinal: 1, execSeq: 3, loopPath: [], status: "passed", durationMs: 1 },
      { caseId: other, ordinal: 2, execSeq: 4, loopPath: [], status: "passed", durationMs: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    expect((await h.readSteps(caseId)).map((s) => s.execSeq)).toEqual([1, 2]);
    expect((await h.readSteps(other)).map((s) => s.execSeq)).toEqual([3, 4]);
  });

  it("carries the identity through a step_finished event, verbatim", async () => {
    // The live gallery is painted from events, not from res_step_results: an identity that only
    // reaches the table arrives minutes late for the surface a QA is actually watching.
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/events`,
      {
        leaseEpoch: job.leaseEpoch,
        seq: 1,
        kind: "step_finished",
        payload: { caseId, ordinal: 2, execSeq: 2, loopPath: [2], status: "passed", durationMs: 11 },
      },
      job.runToken,
    );
    // 202: an event is accepted, never a verdict (at-least-once delivery makes a replay normal).
    expect(res.statusCode).toBe(202);
    expect(await h.runEventPayloads()).toEqual([
      { caseId, ordinal: 2, execSeq: 2, loopPath: [2], status: "passed", durationMs: 11 },
    ]);
  });
});
