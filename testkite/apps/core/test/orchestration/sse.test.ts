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
 * Two of the cases need a REAL socket (an incremental read, and a client that walks away
 * mid-stream), so the harness's app is put on a loopback port. The rest are served by
 * `inject`, because a stream over an ALREADY FINISHED run ends by itself.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import type { SeededTeam } from "../harness/pglite.js";
import { activeRunStreamCount } from "../../src/modules/orchestration/sse.js";

let h: TestApp;
let baseUrl = "";

beforeAll(async () => {
  h = await makeTestApp();
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

async function seedEvents(runId: string, count: number): Promise<void> {
  const jobs = await h.db.raw.query<{ id: string }>(
    `SELECT id FROM job_runs WHERE run_id = $1 ORDER BY chain_key LIMIT 1`,
    [runId],
  );
  const jobRunId = jobs.rows[0]?.id;
  if (jobRunId === undefined) throw new Error("seedEvents: the run has no job");
  for (let seq = 1; seq <= count; seq += 1) {
    await h.db.raw.query(
      `INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, kind, payload)
       VALUES ($1, $2, 1, $3, 'step_finished', $4::jsonb)`,
      [h.ids.teamA, jobRunId, seq, JSON.stringify({ ordinal: seq })],
    );
  }
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

/** Spins the event loop until `check()` holds; vitest's own timeout is the failure mode. */
async function waitUntil(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
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
    await seedEvents(runId, 6);
    const res = await inject(runId, h.tokens.authorA);
    const events = parseFrames(res.body).filter((f) => f.event === "run_event");
    expect(events.map((f) => f.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("resumes from Last-Event-ID instead of replaying the whole run", async () => {
    const runId = await seedFinishedRun();
    await seedEvents(runId, 6);
    const res = await inject(runId, h.tokens.authorA, { "last-event-id": "3" });
    const frames = parseFrames(res.body);
    expect(frames.filter((f) => f.event === "run_event").map((f) => f.id)).toEqual(["4", "5", "6"]);
    expect(frames.every((f) => Number(f.id) > 3)).toBe(true);
  });

  it("closes its poll timer when the client goes away", async () => {
    const runId = await seedLiveRun();
    // Warm-up: the first socket of a server also allocates node's own per-duration timer
    // list, which would read as a leak on a one-shot measurement.
    await openThenAbort(runId);
    const before = timeoutCount();
    await openThenAbort(runId);
    expect(activeRunStreamCount()).toBe(0);
    expect(timeoutCount()).toBe(before);
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
