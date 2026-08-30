/**
 * The PUBLIC run plane: `POST /v1/runs`, `GET /v1/runs/{runId}`, `POST /v1/runs/{runId}/abort`.
 *
 * Everything here goes over HTTP through the REAL app (auth hook, scope gate, error handler),
 * because the subject is the tenant-facing contract, not the services behind it — those have
 * their own tests. Two things this file is deliberately strict about:
 *
 *  1. A project or a case belonging to somebody else answers 404, never 403 (blueprint §3 L3).
 *  2. A compile error is a 200 ANSWER, not an HTTP failure: the request was well formed and the
 *     product has a verdict for it (`compile_error` + the diagnostics). Returning 400 would tell
 *     a CI client to retry a deterministic outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import type { SeededTeam } from "../harness/pglite.js";
import { heartbeatJob } from "../../src/modules/orchestration/queue/job-queue.js";

let h: TestApp;

beforeAll(async () => {
  h = await makeTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
});

/** The shared HTTP harness keeps its ids flat; the pglite fixtures want them as a tenant. */
const teamA = (): SeededTeam => ({
  teamId: h.ids.teamA,
  projectId: h.ids.projectA,
  userId: h.ids.authorUser,
});
const teamB = (): SeededTeam => ({
  teamId: h.ids.teamB,
  projectId: h.ids.projectB,
  userId: h.ids.adminUser,
});

function post(
  url: string,
  token: string,
  payload?: Readonly<Record<string, unknown>>,
): ReturnType<TestApp["app"]["inject"]> {
  return h.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function get(url: string, token: string): ReturnType<TestApp["app"]["inject"]> {
  return h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

interface JobRow {
  readonly id: string;
  readonly status: string;
  readonly lease_epoch: number;
  readonly chain_key: string;
}

async function jobsOf(runId: string): Promise<readonly JobRow[]> {
  const r = await h.db.raw.query<JobRow>(
    `SELECT id, status::text AS status, lease_epoch, chain_key
       FROM job_runs WHERE run_id = $1 ORDER BY chain_key`,
    [runId],
  );
  return r.rows;
}

/** Queues a real run for team A through the real route; returns its id. */
async function triggerRun(count: number): Promise<string> {
  const caseIds = await h.db.seedRunnableCases(teamA(), count);
  const res = await post("/v1/runs", h.tokens.authorA, {
    projectId: h.ids.projectA,
    caseIds,
    pin: "latest",
  });
  if (res.statusCode !== 202) {
    throw new Error(`triggerRun: expected 202, got ${String(res.statusCode)} ${res.body}`);
  }
  return res.json<{ runId: string }>().runId;
}

describe("POST /v1/runs", () => {
  it("queues a run and answers 202 with the frozen plan hash and one job per chain", async () => {
    const caseIds = await h.db.seedRunnableCases(teamA(), 2);
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectA,
      caseIds,
      pin: "latest",
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{
      runId: string;
      status: string;
      planContentHash: string;
      chainTotal: number;
    }>();
    expect(body.status).toBe("queued");
    expect(body.planContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.chainTotal).toBe(2);
    const jobs = await jobsOf(body.runId);
    expect(jobs.length).toBe(2);
    expect(jobs.every((j) => j.status === "pending")).toBe(true);
  });

  it("404s a project belonging to another team rather than 403", async () => {
    // Team A's own project needs to exist as a runnable target too, otherwise the 404 could
    // just as well be about a missing environment on the caller's side.
    const caseIds = await h.db.seedRunnableCases(teamA(), 1);
    await h.db.seedRunnableCases(teamB(), 1);
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectB,
      caseIds,
      pin: "latest",
    });
    expect(res.statusCode, "403 would confirm the project exists").toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("404s a case belonging to another team rather than 403", async () => {
    await h.db.seedRunnableCases(teamA(), 1);
    const foreign = await h.db.seedRunnableCases(teamB(), 1);
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectA,
      caseIds: foreign,
      pin: "latest",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("429 RATE_LIMITED with a Retry-After header once the day's run budget is spent", async () => {
    const caseIds = await h.db.seedRunnableCases(teamA(), 1);
    await h.db.raw.query(`UPDATE quota_limits SET max_runs_per_day = 0 WHERE team_id = $1`, [
      h.ids.teamA,
    ]);
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectA,
      caseIds,
      pin: "latest",
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(await h.db.countRows("orc_runs")).toBe(0);
  });

  it("answers 200 with verdict compile_error and the diagnostics, queueing nothing", async () => {
    const caseId = await h.db.seedCaseWithPendingLocator(teamA());
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectA,
      caseIds: [caseId],
      pin: "latest",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      runId: string;
      verdict: string;
      diagnostics: { code: string; caseId: string }[];
    }>();
    expect(body.verdict).toBe("compile_error");
    expect(body.diagnostics.map((d) => d.code)).toContain("element_pending_locator");
    expect(await h.db.countRows("job_runs")).toBe(0);
  });

  it("403s a credential whose role has no run:trigger — same tenant, missing permission", async () => {
    const caseIds = await h.db.seedRunnableCases(teamA(), 1);
    const res = await post("/v1/runs", h.tokens.orgAdminA, {
      projectId: h.ids.projectA,
      caseIds,
      pin: "latest",
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s a body with no case at all instead of opening an empty run", async () => {
    const res = await post("/v1/runs", h.tokens.authorA, {
      projectId: h.ids.projectA,
      caseIds: [],
    });
    expect(res.statusCode).toBe(400);
    expect(await h.db.countRows("orc_runs")).toBe(0);
  });
});

describe("GET /v1/runs/{runId}", () => {
  it("reports the run aggregate with one entry per chain", async () => {
    const runId = await triggerRun(2);
    const res = await get(`/v1/runs/${runId}`, h.tokens.authorA);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      runId: string;
      projectId: string;
      status: string;
      verdict: string;
      chainTotal: number;
      chainDone: number;
      jobs: { jobRunId: string; chainKey: string; status: string; attempt: number }[];
      diagnostics: unknown[];
    }>();
    expect(body.runId).toBe(runId);
    expect(body.projectId).toBe(h.ids.projectA);
    expect(body.status).toBe("queued");
    expect(body.verdict).toBe("pending");
    expect(body.chainTotal).toBe(2);
    expect(body.chainDone).toBe(0);
    expect(body.jobs.length).toBe(2);
    expect(body.jobs.every((j) => j.status === "pending" && j.attempt === 1)).toBe(true);
    expect(body.diagnostics).toEqual([]);
  });

  it("counts finished chains in chainDone, derived from the queue and not from a stale column", async () => {
    const runId = await triggerRun(2);
    const jobs = await jobsOf(runId);
    await h.db.raw.query(
      `UPDATE job_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
      [jobs[0]?.id],
    );
    const body = (await get(`/v1/runs/${runId}`, h.tokens.authorA)).json<{ chainDone: number }>();
    expect(body.chainDone).toBe(1);
  });

  it("404s another team's run rather than 403", async () => {
    const runId = await triggerRun(1);
    const res = await get(`/v1/runs/${runId}`, h.tokens.adminB);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("POST /v1/runs/{runId}/abort", () => {
  it("cancels every non-terminal job, bumps its epoch and leaves a finished one alone", async () => {
    const runId = await triggerRun(2);
    const before = await jobsOf(runId);
    const done = before[0];
    const live = before[1];
    if (done === undefined || live === undefined) throw new Error("expected two jobs");
    await h.db.raw.query(
      `UPDATE job_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
      [done.id],
    );

    const res = await post(`/v1/runs/${runId}/abort`, h.tokens.adminA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId, verdict: "cancelled", cancelledJobs: 1 });

    const after = await jobsOf(runId);
    const stillDone = after.find((j) => j.id === done.id);
    const cancelled = after.find((j) => j.id === live.id);
    expect(stillDone?.status).toBe("succeeded");
    expect(stillDone?.lease_epoch).toBe(done.lease_epoch);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.lease_epoch).toBe(live.lease_epoch + 1);

    const run = await h.db.raw.query<{ status: string; verdict: string }>(
      `SELECT status::text AS status, verdict::text AS verdict FROM orc_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "finished", verdict: "cancelled" });
  });

  it("fences a worker still holding the pre-abort epoch", async () => {
    const runId = await triggerRun(1);
    const [job] = await jobsOf(runId);
    if (job === undefined) throw new Error("expected one job");
    await post(`/v1/runs/${runId}/abort`, h.tokens.adminA);
    const outcome = await h.db.asTeamCtx(h.ids.teamA, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job.id, epoch: job.lease_epoch, now: new Date() }),
    );
    expect(outcome.ok, "the zombie must not be able to renew a cancelled lease").toBe(false);
  });

  it("404s another team's run rather than 403", async () => {
    const runId = await triggerRun(1);
    const res = await post(`/v1/runs/${runId}/abort`, h.tokens.adminB);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    const jobs = await jobsOf(runId);
    expect(jobs.every((j) => j.status === "pending")).toBe(true);
  });
});
