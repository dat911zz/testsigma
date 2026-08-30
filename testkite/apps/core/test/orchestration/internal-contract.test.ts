/**
 * `/internal/fleet` — the surface the fleet plan codes against (plan "Hop dong cho plan fleet").
 *
 * The subject of this file is the FENCE, not the happy path: every mutation a worker can send
 * must be refused when the epoch is missing, stale, or belongs to another job — because the
 * only thing standing between a `-9`-ed worker's zombie and a second verdict on one chain is
 * that refusal. Each of the four job mutations is driven from ONE table, so a fifth endpoint
 * cannot be added without being covered here too (internal-coverage.test.ts turns that silence
 * red).
 *
 * Deliberate deviations from the plan's block (Task 13, Step 2):
 *  - `makeInternalTestApp()` reuses one migrated PGlite + one Fastify instance across the file
 *    and reseeds per test (migrate() costs ~3.6s, TRUNCATE ~2ms) — same shape as every other
 *    suite here; `closeInternalTestApp()` in afterAll is what the plan's block left implicit.
 *  - "404s a job of another team" and "401s a run token minted for a DIFFERENT job" are BOTH
 *    kept, which forces the hook to tell the two cases apart: it probes for the path's job
 *    UNDER THE TOKEN'S OWN TENANT, so a job the tenant cannot see is a 404 (never a 403, never
 *    a confirmation that another team's id exists) while one it CAN see is a credential
 *    mismatch, i.e. 401. See src/http/internal/app.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  artifactResponseSchema,
  claimedJobSchema,
  completeResponseSchema,
  eventResponseSchema,
  jobHeartbeatResponseSchema,
  registerResponseSchema,
} from "@testkite/contract";
import {
  closeInternalTestApp,
  makeInternalTestApp,
  type InternalTestApp,
} from "../harness/internal.js";

describe("/internal/fleet — leaseEpoch is mandatory on every mutation", () => {
  let h: InternalTestApp;
  beforeEach(async () => {
    h = await makeInternalTestApp();
  });
  afterAll(async () => {
    await closeInternalTestApp();
  });

  // The four mutating endpoints, driven from one table so a NEW endpoint cannot be added
  // without also being covered here (internal-coverage.test.ts enforces that).
  const MUTATIONS = [
    { name: "heartbeat", path: (j: string) => `/internal/fleet/jobs/${j}/heartbeat`, body: {} },
    {
      name: "events",
      path: (j: string) => `/internal/fleet/jobs/${j}/events`,
      body: { seq: 1, kind: "chain_started", payload: {} },
    },
    {
      name: "artifacts",
      path: (j: string) => `/internal/fleet/jobs/${j}/artifacts`,
      body: { kind: "trace", contentType: "application/zip", sizeBytes: 10, sha256: "0".repeat(64) },
    },
    {
      name: "complete",
      path: (j: string) => `/internal/fleet/jobs/${j}/complete`,
      body: { verdict: "passed", steps: [], artifacts: [] },
    },
  ] as const;

  for (const m of MUTATIONS) {
    it(`${m.name}: rejects a body with no leaseEpoch at all (400)`, async () => {
      const job = await h.claimOneJob();
      const res = await h.post(m.path(job.jobRunId), m.body, job.runToken);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it(`${m.name}: rejects an epoch the reaper has already moved past (409 STALE_EPOCH)`, async () => {
      const job = await h.claimOneJob();
      await h.reapJob(job.jobRunId);
      const res = await h.post(
        m.path(job.jobRunId),
        { ...m.body, leaseEpoch: job.leaseEpoch },
        job.runToken,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: "STALE_EPOCH",
        currentEpoch: job.leaseEpoch + 1,
      });
    });

    it(`${m.name}: 404s a job of another team — never 403`, async () => {
      const job = await h.claimOneJob();
      const foreign = await h.jobIdOfOtherTeam();
      const res = await h.post(m.path(foreign), { ...m.body, leaseEpoch: 1 }, job.runToken);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    });

    it(`${m.name}: 401s a worker token — a worker token may only register and claim`, async () => {
      const job = await h.claimOneJob();
      const res = await h.post(
        m.path(job.jobRunId),
        { ...m.body, leaseEpoch: job.leaseEpoch },
        h.workerToken,
      );
      expect(res.statusCode).toBe(401);
    });

    it(`${m.name}: 401s a run token minted for a DIFFERENT job`, async () => {
      const a = await h.claimOneJob();
      const b = await h.claimOneJob();
      const res = await h.post(m.path(a.jobRunId), { ...m.body, leaseEpoch: a.leaseEpoch }, b.runToken);
      expect(res.statusCode).toBe(401);
    });

    it(`${m.name}: 410 JOB_CANCELLED once the run is aborted`, async () => {
      const job = await h.claimOneJob();
      await h.cancelRun(job.runId);
      const res = await h.post(
        m.path(job.jobRunId),
        { ...m.body, leaseEpoch: job.leaseEpoch },
        job.runToken,
      );
      expect(res.statusCode).toBe(410);
      expect(res.json()).toMatchObject({ code: "JOB_CANCELLED" });
    });
  }

  it("register: needs the bootstrap token and hands back a worker token", async () => {
    const res = await h.post(
      "/internal/fleet/workers/register",
      { workerId: "w9", hostname: "host-1", lane: "batch", capacity: 4 },
      h.bootstrapToken,
    );
    expect(res.statusCode).toBe(200);
    const body = registerResponseSchema.parse(res.json());
    expect(body).toMatchObject({ workerId: "w9", lane: "batch", heartbeatIntervalMs: 5000, drain: false });
    expect(body.workerToken).toMatch(/^tkw_/);
  });

  it("register: 401s a worker token — registration is the one thing only the host may do", async () => {
    const res = await h.post(
      "/internal/fleet/workers/register",
      { workerId: "w9", hostname: "h", lane: "batch", capacity: 4 },
      h.workerToken,
    );
    expect(res.statusCode).toBe(401);
  });

  it("worker heartbeat: answers `drain` once the worker is marked draining", async () => {
    await h.setWorkerDrain(true);
    const res = await h.post(
      `/internal/fleet/workers/${h.workerId}/heartbeat`,
      { freeSlots: 2, psi: { some10: 0.01, full10: 0 }, rssBytes: 1000 },
      h.workerToken,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ command: "drain" });
  });

  it("worker heartbeat: 401s a token belonging to a DIFFERENT worker", async () => {
    const other = await h.registerWorker("w-other");
    const res = await h.post(
      `/internal/fleet/workers/${h.workerId}/heartbeat`,
      { freeSlots: 1 },
      other.workerToken,
    );
    expect(res.statusCode).toBe(401);
  });

  it("claim: 204 with no body when the queue is empty — not an error", async () => {
    await h.drainQueue();
    const res = await h.post(
      "/internal/fleet/claim",
      { workerId: h.workerId, lane: "batch", freeSlots: 3 },
      h.workerToken,
    );
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("claim: returns ONE job, the frozen plan inline, and a run token scoped to that attempt", async () => {
    const res = await h.post(
      "/internal/fleet/claim",
      { workerId: h.workerId, lane: "batch", freeSlots: 3 },
      h.workerToken,
    );
    expect(res.statusCode).toBe(200);
    const job = claimedJobSchema.parse(res.json());
    expect(job).toMatchObject({ attempt: 1, leaseEpoch: 1 });
    expect(job.runToken).toMatch(/^tkr_/);
    expect((job.plan as { contentHash: string }).contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.leaseDeadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("claim: 401s a run token — a run token cannot ask for more work", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      "/internal/fleet/claim",
      { workerId: h.workerId, lane: "batch", freeSlots: 1 },
      job.runToken,
    );
    expect(res.statusCode).toBe(401);
  });

  it("job heartbeat: extends the lease and answers `continue`", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/heartbeat`,
      { leaseEpoch: job.leaseEpoch },
      job.runToken,
    );
    expect(res.statusCode).toBe(200);
    const body = jobHeartbeatResponseSchema.parse(res.json());
    expect(body.command).toBe("continue");
    expect(Date.parse(body.leaseDeadlineAt)).toBeGreaterThan(Date.now());
  });

  it("events: a replayed seq answers 202 duplicate=true, not an error", async () => {
    const job = await h.claimOneJob();
    const body = { leaseEpoch: job.leaseEpoch, seq: 1, kind: "chain_started", payload: {} };
    const first = await h.post(`/internal/fleet/jobs/${job.jobRunId}/events`, body, job.runToken);
    expect(first.statusCode).toBe(202);
    expect(eventResponseSchema.parse(first.json())).toMatchObject({ accepted: true, duplicate: false });
    const replay = await h.post(`/internal/fleet/jobs/${job.jobRunId}/events`, body, job.runToken);
    expect(replay.json()).toMatchObject({ accepted: true, duplicate: true });
  });

  it("events: 400s a kind outside the closed enum", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/events`,
      { leaseEpoch: job.leaseEpoch, seq: 1, kind: "made_up", payload: {} },
      job.runToken,
    );
    expect(res.statusCode).toBe(400);
  });

  it("artifacts: signs a 15-minute PUT and refuses a size over the cap", async () => {
    const job = await h.claimOneJob();
    const ok = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/artifacts`,
      {
        leaseEpoch: job.leaseEpoch,
        kind: "trace",
        contentType: "application/zip",
        sizeBytes: 3304,
        sha256: "a".repeat(64),
      },
      job.runToken,
    );
    expect(ok.statusCode).toBe(200);
    const slot = artifactResponseSchema.parse(ok.json());
    expect(slot.url).toContain("X-Amz-Signature=");
    expect(slot.url).toContain(`/${job.teamId}/`); // the key is tenant-prefixed
    const tooBig = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/artifacts`,
      {
        leaseEpoch: job.leaseEpoch,
        kind: "trace",
        contentType: "application/zip",
        sizeBytes: 3_000_000_000,
        sha256: "a".repeat(64),
      },
      job.runToken,
    );
    expect(tooBig.statusCode).toBe(400);
  });

  it("complete: an assertion failure is terminal and writes the results", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      { leaseEpoch: job.leaseEpoch, verdict: "failed", steps: [h.sampleStep()], artifacts: [] },
      job.runToken,
    );
    expect(res.statusCode).toBe(200);
    expect(completeResponseSchema.parse(res.json())).toMatchObject({ ok: true, requeued: false });
    expect(await h.caseResultCount(job.jobRunId)).toBe(1);
  });

  it("complete: marks the artifacts the worker reports as uploaded", async () => {
    const job = await h.claimOneJob();
    const sha256 = "b".repeat(64);
    await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/artifacts`,
      { leaseEpoch: job.leaseEpoch, kind: "trace", contentType: "application/zip", sizeBytes: 12, sha256 },
      job.runToken,
    );
    expect(await h.artifactStatuses(job.jobRunId)).toEqual(["pending"]);
    await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      {
        leaseEpoch: job.leaseEpoch,
        verdict: "passed",
        steps: [],
        artifacts: [{ kind: "trace", sha256, sizeBytes: 12 }],
      },
      job.runToken,
    );
    expect(await h.artifactStatuses(job.jobRunId)).toEqual(["uploaded"]);
  });

  it("complete: an infraError requeues, bumps attempt, and revokes the run token on the spot", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      {
        leaseEpoch: job.leaseEpoch,
        infraError: {
          code: "browser_oom",
          retryable: true,
          message: "killed",
          peakRssBytes: 1728053248,
        },
      },
      job.runToken,
    );
    expect(res.json()).toMatchObject({ ok: true, requeued: true, attempt: 2 });
    // The token died with the lease: the next call is 401, not 409.
    const after = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/heartbeat`,
      { leaseEpoch: 2 },
      job.runToken,
    );
    expect(after.statusCode).toBe(401);
  });

  it("complete: refuses a body carrying neither a verdict nor an infraError", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      { leaseEpoch: job.leaseEpoch, steps: [], artifacts: [] },
      job.runToken,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("complete: writes NO result when the epoch is stale — the whole call rolls back", async () => {
    const job = await h.claimOneJob();
    await h.reapJob(job.jobRunId);
    const res = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      { leaseEpoch: job.leaseEpoch, verdict: "passed", steps: [h.sampleStep()], artifacts: [] },
      job.runToken,
    );
    expect(res.statusCode).toBe(409);
    expect(
      await h.caseResultCount(job.jobRunId),
      "a zombie must not leave a verdict behind",
    ).toBe(0);
  });

  it("complete: a second complete on a finished job answers 410 JOB_TERMINAL", async () => {
    const job = await h.claimOneJob();
    const body = { leaseEpoch: job.leaseEpoch, verdict: "passed", steps: [], artifacts: [] };
    await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, body, job.runToken);
    const again = await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, body, job.runToken);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: "JOB_TERMINAL" });
  });

  it("serves /internal/fleet on its own instance and never mounts /v1 there", async () => {
    expect((await h.get("/v1/runs", h.workerToken)).statusCode).toBe(404);
  });
});
