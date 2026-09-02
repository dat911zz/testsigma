/**
 * `GET /v1/runs/{runId}/stream` — server-sent events for one run.
 *
 * Spike 2026-08-29 (Fastify 5.12.1): SSE needs NO plugin. `reply.hijack()` + writes on
 * `reply.raw` is the whole mechanism — and the two consequences it drags along are exactly
 * what this file pins down:
 *
 *  - the auth hook still runs, and it runs BEFORE the hijack, so 401/404 are still ordinary
 *    JSON answers (`app.inject` can read them);
 *  - nothing closes the connection for us, so the poll timer only dies if the handler
 *    subscribes to `req.raw.on("close")`. That one is measured here rather than reviewed:
 *    an abandoned tab that leaks a timer also leaks one database query per second, forever.
 *
 * Three of the cases need a REAL socket (two incremental reads, and a client that walks away
 * mid-stream), so the harness's app is put on a loopback port. The rest are served by
 * `inject`, because a stream over an ALREADY FINISHED run ends by itself.
 *
 * `id:` IS A CONTRACT. It is `run_ordinal` — one number per run, handed out once at insert —
 * and the multi-chain case below is why it cannot be an array position over an
 * (attempt, seq) read: those two counters restart at 1 for every chain.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import type { SeededTeam } from "../harness/pglite.js";
import {
  activeRunStreamCount,
  type IntervalHandle,
} from "../../src/modules/orchestration/sse.js";
import { recordRunEvent } from "../../src/modules/orchestration/events.js";

let h: TestApp;
let baseUrl = "";

/**
 * The interval handles the app under test opened, and the ones it has not handed back yet.
 * `streamRun` takes both functions as ports, so this ledger covers exactly the timers ONE
 * stream created.
 *
 * It replaces a `process.getActiveResourcesInfo()` reading. That one was PROCESS-WIDE, and
 * `vitest.config.ts` puts this app's whole suite in a single fork, so any timer born or buried
 * elsewhere between two readings landed on this test's ledger: CI runs 33393369459 and
 * 33395811296 both failed here with `expected 1 to be 2` on commits that changed nothing but
 * markdown. The leak being measured is real; the instrument was not.
 */
const timers = {
  opened: 0,
  live: new Set<IntervalHandle>(),
  setIntervalFn(fn: () => void, ms: number): IntervalHandle {
    const handle = setInterval(fn, ms);
    timers.opened += 1;
    timers.live.add(handle);
    return handle;
  },
  clearIntervalFn(handle: IntervalHandle): void {
    clearInterval(handle);
    timers.live.delete(handle);
  },
};

beforeAll(async () => {
  h = await makeTestApp({
    stream: { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
  });
  baseUrl = await h.app.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
});

const teamA = (): SeededTeam => ({
  teamId: h.ids.teamA,
  projectId: h.ids.projectA,
  userId: h.ids.authorUser,
});

interface SseFrame {
  readonly id: string;
  readonly event: string;
  readonly data: string;
}

/**
 * Parses a wire dump into frames. Comment blocks (`: stream open`, `: ping`) are dropped —
 * they carry no event, and asserting on them separately is what the first test is for.
 */
function parseFrames(raw: string): readonly SseFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.length > 0 && !block.startsWith(":"))
    .map((block) => {
      let id = "";
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      return { id, event, data: data.join("\n") };
    });
}

/** One run whose chains are all finished — the stream over it closes on its own first tick. */
async function seedFinishedRun(): Promise<string> {
  const { runId } = await h.db.seedRunWithJobs(teamA(), 1);
  await h.db.raw.query(
    `UPDATE job_runs SET status = 'succeeded', finished_at = now() WHERE run_id = $1`,
    [runId],
  );
  await h.db.raw.query(
    `UPDATE orc_runs SET status = 'finished', verdict = 'passed', finished_at = now() WHERE id = $1`,
    [runId],
  );
  return runId;
}

/** A run with a job still sitting in the queue: the stream stays open until someone leaves. */
async function seedLiveRun(): Promise<string> {
  const { runId } = await h.db.seedRunWithJobs(teamA(), 1);
  await h.db.raw.query(`UPDATE orc_runs SET status = 'queued' WHERE id = $1`, [runId]);
  return runId;
}

/**
 * Through `recordRunEvent`, never a raw INSERT: `run_ordinal` — the number this suite asserts
 * on as the frame `id:` — is handed out by that function, so a fixture that wrote the row
 * itself would be asserting on numbers the fixture chose.
 */
async function seedEvents(jobRunId: string, seqs: readonly number[]): Promise<void> {
  for (const seq of seqs) {
    await h.db.asTeamCtx(h.ids.teamA, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId,
        attempt: 1,
        seq,
        kind: "step_finished",
        payload: { ordinal: seq },
      }),
    );
  }
}

/** The run's chains, in the order `seedRunWithJobs` created them. */
async function chainsOf(runId: string): Promise<readonly string[]> {
  const jobs = await h.db.raw.query<{ id: string }>(
    `SELECT id FROM job_runs WHERE run_id = $1 ORDER BY chain_key`,
    [runId],
  );
  return jobs.rows.map((row) => row.id);
}

async function firstChainOf(runId: string): Promise<string> {
  const first = (await chainsOf(runId))[0];
  if (first === undefined) throw new Error("seedEvents: the run has no job");
  return first;
}

function inject(
  runId: string,
  token: string | null,
  headers: Readonly<Record<string, string>> = {},
): ReturnType<TestApp["app"]["inject"]> {
  return h.app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/stream`,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
  });
}

/**
 * Frames that have arrived WHOLE. A chunk boundary can fall inside a frame, and counting a
 * half-written one would make the multi-chain test act a poll too early.
 */
function completeFrames(raw: string): readonly SseFrame[] {
  const end = raw.lastIndexOf("\n\n");
  return end < 0 ? [] : parseFrames(raw.slice(0, end + 2));
}

/** The `jobRunId` a `run_event` frame names — the chain the event belongs to. */
function jobRunIdOf(frame: SseFrame): string {
  const parsed: unknown = JSON.parse(frame.data);
  if (typeof parsed !== "object" || parsed === null || !("jobRunId" in parsed)) {
    throw new Error(`run_event frame carries no jobRunId: ${frame.data}`);
  }
  const id: unknown = parsed.jobRunId;
  if (typeof id !== "string") throw new Error(`run_event jobRunId is not a string: ${frame.data}`);
  return id;
}

/** Spins the event loop until `check()` holds; vitest's own timeout is the failure mode. */
async function waitUntil(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Opens a stream over a real socket, waits for the first byte, then walks away. */
async function openThenAbort(runId: string): Promise<void> {
  const opened = new Promise<IncomingMessage>((resolve) => {
    const req = httpRequest(
      `${baseUrl}/v1/runs/${runId}/stream`,
      { headers: { authorization: `Bearer ${h.tokens.authorA}` } },
      (res) => {
        res.on("data", () => undefined);
        res.on("error", () => undefined);
        resolve(res);
      },
    );
    req.on("error", () => undefined);
    req.end();
  });
  const res = await opened;
  await waitUntil(() => activeRunStreamCount() > 0);
  res.destroy();
  await waitUntil(() => activeRunStreamCount() === 0);
}

describe("GET /v1/runs/:runId/stream", () => {
  it("answers with an SSE content type and a comment frame first", async () => {
    const runId = await seedFinishedRun();
    const res = await inject(runId, h.tokens.authorA);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(String(res.headers["cache-control"])).toContain("no-cache");
    // nginx buffers text/* and would hold every frame until the run ends.
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.body.startsWith(": ")).toBe(true);
  });

  it("emits a status frame and a terminal done frame when the run finishes", async () => {
    const runId = await seedLiveRun();
    const frames = await new Promise<readonly SseFrame[]>((resolve) => {
      let raw = "";
      const req = httpRequest(
        `${baseUrl}/v1/runs/${runId}/stream`,
        { headers: { authorization: `Bearer ${h.tokens.authorA}` } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            raw += chunk;
            if (raw.includes("event: done")) {
              res.destroy();
              resolve(parseFrames(raw));
            }
          });
          res.on("error", () => undefined);
        },
      );
      req.on("error", () => undefined);
      req.end();
      // The run reaches its verdict only after the stream is already open: the point is that
      // the poll NOTICES it, not that it read a terminal row once at connect time.
      void waitUntil(() => raw.includes("event: status")).then(async () => {
        await h.db.raw.query(
          `UPDATE job_runs SET status = 'succeeded', finished_at = now() WHERE run_id = $1`,
          [runId],
        );
        await h.db.raw.query(
          `UPDATE orc_runs SET status = 'finished', verdict = 'passed', finished_at = now() WHERE id = $1`,
          [runId],
        );
      });
    });
    expect(frames.map((f) => f.event)).toContain("status");
    expect(frames.at(-1)?.event).toBe("done");
    const done = frames.at(-1);
    expect(JSON.parse(done?.data ?? "{}")).toMatchObject({ runId, verdict: "passed" });
    await waitUntil(() => activeRunStreamCount() === 0);
  }, 20_000);

  it("replays the whole narration when no cursor is supplied", async () => {
    const runId = await seedFinishedRun();
    await seedEvents(await firstChainOf(runId), [1, 2, 3, 4, 5, 6]);
    const res = await inject(runId, h.tokens.authorA);
    const events = parseFrames(res.body).filter((f) => f.event === "run_event");
    expect(events.map((f) => f.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("carries a step's execution identity into the SSE frame", async () => {
    // The live gallery is painted from THIS surface, not from res_step_results. `execSeq` and
    // `loopPath` are what tell a QA that three frames of "Type $data:user" are row 1, row 2 and
    // row 3 rather than one step redrawn three times, so they have to survive the jsonb round
    // trip and the frame serializer — neither of which knows the two field names, which is
    // exactly why nothing but a test says they still arrive.
    const runId = await seedFinishedRun();
    const jobRunId = await firstChainOf(runId);
    await h.db.asTeamCtx(h.ids.teamA, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId,
        attempt: 1,
        seq: 1,
        kind: "step_finished",
        payload: { caseId: "c1", ordinal: 2, execSeq: 2, loopPath: [2], status: "passed" },
      }),
    );
    const res = await inject(runId, h.tokens.authorA);
    const event = parseFrames(res.body).find((f) => f.event === "run_event");
    if (event === undefined) throw new Error("the stream carried no run_event frame");
    expect(event.data).toContain('"execSeq":2');
    expect(event.data).toContain('"loopPath":[2]');
  });

  it("resumes from Last-Event-ID instead of replaying the whole run", async () => {
    const runId = await seedFinishedRun();
    await seedEvents(await firstChainOf(runId), [1, 2, 3, 4, 5, 6]);
    const res = await inject(runId, h.tokens.authorA, { "last-event-id": "3" });
    const frames = parseFrames(res.body);
    expect(frames.filter((f) => f.event === "run_event").map((f) => f.id)).toEqual(["4", "5", "6"]);
    expect(frames.every((f) => Number(f.id) > 3)).toBe(true);
  });

  it("keeps numbering a SECOND chain's first event above the cursor it already handed out", async () => {
    // THE MULTI-CHAIN REGRESSION. Every chain restarts `attempt`/`seq` at 1, so chain B's
    // first-ever event (1, 1) sorts in front of chain A's (1, 2) and (1, 3) under any
    // (attempt, seq) ordering. The first cut numbered frames by ARRAY POSITION over exactly
    // that ordering, which meant: B's brand-new event landed at position 2 — below the cursor
    // the client had already acked — and was never sent, while A's third event was renumbered
    // to 4 and sent a second time as if it were new. A run with 2+ chains is the ordinary case
    // for a multi-case run, so this was a silent drop on the normal path, not an edge case.
    const { runId } = await h.db.seedRunWithJobs(teamA(), 2);
    await h.db.raw.query(`UPDATE orc_runs SET status = 'queued' WHERE id = $1`, [runId]);
    const [chainA, chainB] = await chainsOf(runId);
    if (chainA === undefined || chainB === undefined) throw new Error("seed: expected two chains");
    await seedEvents(chainA, [1, 2, 3]);

    const delivered = await new Promise<readonly SseFrame[]>((resolve) => {
      let raw = "";
      let narratedB = false;
      const req = httpRequest(
        `${baseUrl}/v1/runs/${runId}/stream`,
        { headers: { authorization: `Bearer ${h.tokens.authorA}` } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            raw += chunk;
            const events = completeFrames(raw).filter((f) => f.event === "run_event");
            // Only once chain A's three are ON THE WIRE — the client has acked cursor 3 —
            // does chain B open its mouth. That ordering IS the bug's precondition.
            if (!narratedB && events.length >= 3) {
              narratedB = true;
              void seedEvents(chainB, [1]);
            }
            if (narratedB && events.length >= 4) {
              res.destroy();
              resolve(completeFrames(raw));
            }
          });
          res.on("error", () => undefined);
        },
      );
      req.on("error", () => undefined);
      req.end();
    });

    const events = delivered.filter((f) => f.event === "run_event");
    // No renumbering: A's three keep the ids they were sent under, and B's event is the FOURTH.
    expect(events.map((f) => f.id)).toEqual(["1", "2", "3", "4"]);
    expect(events.map(jobRunIdOf)).toEqual([chainA, chainA, chainA, chainB]);
    await waitUntil(() => activeRunStreamCount() === 0);
  }, 20_000);

  it("closes its poll timer when the client goes away", async () => {
    const runId = await seedLiveRun();
    const opened = timers.opened;
    const live = timers.live.size;
    await openThenAbort(runId);
    expect(activeRunStreamCount()).toBe(0);
    // One stream opens exactly two handles — the 1s poll and the 15s heartbeat — and an
    // abandoned tab must hand BOTH back. Node's own timer bookkeeping is no longer part of the
    // reading, so the warm-up round this test used to need is gone with it.
    expect(timers.opened - opened).toBe(2);
    expect(timers.live.size).toBe(live);
  }, 20_000);

  it("404s another team's run rather than streaming it", async () => {
    const runId = await seedFinishedRun();
    const res = await inject(runId, h.tokens.adminB);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("401s without a credential — the auth hook runs BEFORE the hijack", async () => {
    const runId = await seedFinishedRun();
    const res = await inject(runId, null);
    expect(res.statusCode).toBe(401);
  });
});
