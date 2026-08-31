/**
 * WHAT THIS SUITE PROVES, AND WHERE IT STOPS.
 *
 * Proven here, for real, over a real socket against the contract's own schemas: which credential
 * each call presents, that `leaseEpoch` rides on EVERY job mutation, that a 409 STALE_EPOCH is
 * raised once and never retried, that a 410 tells cancelled and terminal apart, that a 429 is
 * obeyed through its `Retry-After` header, that the closed event and artifact vocabularies are
 * enforced BEFORE a socket is opened, and that the four presentation fields the step gallery
 * needs survive the trip to `complete`.
 *
 * NOT proven here: anything the far end decides. Lease reaping, `FOR UPDATE SKIP LOCKED` claim
 * semantics, run-token TTL, real presigned signatures and cross-tenant isolation live in the
 * control plane's own suites (`apps/core`). A green run here means THE WORKER SPEAKS THE
 * CONTRACT — not that a real control plane agrees with it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_MAX_SIZE_BYTES,
  claimedJobSchema,
  FatalInfraError,
  NotFoundError,
  RetryableInfraError,
  RUN_EVENT_KIND_VALUES,
  UnauthorizedError,
} from "@testkite/contract";
import { freezePlan, type RunPlan } from "@testkite/run-compiler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HttpControlPlaneClient,
  JobCancelledError,
  JobTerminalError,
  StaleEpochError,
  type ClaimedJob,
} from "../src/control-plane-client.js";
import { FAKE_BOOTSTRAP_TOKEN, FAKE_RUN_TOKEN, FAKE_WORKER_TOKEN, FakeControlPlane } from "./harness/fake-control-plane.js";

const plan: RunPlan = freezePlan({
  teamId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  baseUrl: "https://staging.test",
  lane: "batch",
  chains: [{ chainKey: "login>checkout", cases: [] }],
});

const registration = {
  workerId: "host1-w1",
  hostname: "host1",
  lane: "batch",
  capacity: 4,
} as const;

const sha = "a".repeat(64);
const caseId = "33333333-3333-4333-8333-333333333333";

let cp: FakeControlPlane;
let client: HttpControlPlaneClient;
let slept: number[];

beforeEach(async () => {
  cp = new FakeControlPlane();
  await cp.start();
  slept = [];
  client = new HttpControlPlaneClient({
    baseUrl: cp.url,
    bootstrapToken: FAKE_BOOTSTRAP_TOKEN,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
});

afterEach(async () => {
  await cp.stop();
});

async function claimOne(): Promise<ClaimedJob> {
  await client.register(registration);
  cp.nextJob = { chainKey: "login>checkout", plan };
  const job = await client.claim({ freeSlots: 4 });
  if (job === null) throw new Error("expected a job");
  return job;
}

describe("HttpControlPlaneClient", () => {
  it("registers with the BOOTSTRAP token and uses the worker token afterwards", async () => {
    const reg = await client.register(registration);
    expect(reg).toMatchObject({ workerId: "host1-w1", workerToken: FAKE_WORKER_TOKEN, heartbeatIntervalMs: 5_000, drain: false });
    expect(cp.calls.at(-1)?.auth).toBe(`Bearer ${FAKE_BOOTSTRAP_TOKEN}`);

    await client.claim({ freeSlots: 4 });
    expect(cp.calls.at(-1)?.auth).toBe(`Bearer ${FAKE_WORKER_TOKEN}`);
  });

  it("returns null on 204 rather than throwing — an empty queue is normal", async () => {
    await client.register(registration);
    expect(await client.claim({ freeSlots: 4 })).toBeNull();
  });

  it("refuses to call the plane before registering, without opening a socket", async () => {
    await expect(client.claim({ freeSlots: 4 })).rejects.toBeInstanceOf(FatalInfraError);
    expect(cp.calls).toHaveLength(0);
  });

  it("fills workerId and lane from the registration, so the body can never disagree with the token", async () => {
    await client.register(registration);
    cp.nextJob = { chainKey: "login>checkout", plan };
    await client.claim({ freeSlots: 4 });
    expect(cp.calls.at(-1)?.body).toMatchObject({ workerId: "host1-w1", lane: "batch", freeSlots: 4 });
  });

  it("carries the claimed plan, epoch and run token through unchanged", async () => {
    const job = await claimOne();
    expect(job.leaseEpoch).toBe(cp.currentEpoch);
    expect(job.jobRunId).toBe(cp.jobRunId);
    expect(job.teamId).toBe(cp.teamId);
    expect(job.runToken).toBe(FAKE_RUN_TOKEN);
    expect(job.plan.contentHash).toBe(plan.contentHash);
    expect(job.plan.chains[0]?.timeoutSeconds).toBe(plan.chains[0]?.timeoutSeconds);
  });

  it("refuses a plan whose format version it does not implement", async () => {
    await client.register(registration);
    cp.nextJob = { chainKey: "login>checkout", plan: { ...plan, planFormatVersion: 99 } as unknown as RunPlan };
    await expect(client.claim({ freeSlots: 4 })).rejects.toBeInstanceOf(FatalInfraError);
  });

  it("uses the RUN token — not the worker token — for every job mutation", async () => {
    const job = await claimOne();
    await client.jobHeartbeat(job);
    await client.event(job, { seq: 1, kind: "chain_started", payload: {} });
    await client.complete(job, { verdict: "passed", steps: [], artifacts: [] });
    const mutations = cp.calls.filter((c) => c.path.includes("/jobs/"));
    expect(mutations).toHaveLength(3);
    for (const call of mutations) expect(call.auth).toBe(`Bearer ${FAKE_RUN_TOKEN}`);
  });

  it("sends leaseEpoch on EVERY job mutation", async () => {
    const job = await claimOne();
    await client.jobHeartbeat(job);
    await client.event(job, { seq: 1, kind: "step_finished", payload: { ordinal: 1 } });
    await client.artifactTicket(job, { kind: "trace", contentType: "application/zip", sha256: sha, sizeBytes: 3304 });
    await client.complete(job, { verdict: "passed", steps: [], artifacts: [] });
    const mutations = cp.calls.filter((c) => c.path.includes("/jobs/"));
    expect(mutations).toHaveLength(4);
    for (const call of mutations) expect(call.body["leaseEpoch"]).toBe(job.leaseEpoch);
  });

  it("addresses the paths the contract publishes, with the job id substituted", async () => {
    const job = await claimOne();
    await client.event(job, { seq: 1, kind: "case_started", payload: {} });
    expect(cp.calls.at(-1)?.path).toBe(`/internal/fleet/jobs/${job.jobRunId}/events`);
  });

  it("accepts every kind in the closed event vocabulary", async () => {
    const job = await claimOne();
    let seq = 0;
    for (const kind of RUN_EVENT_KIND_VALUES) {
      seq += 1;
      const ack = await client.event(job, { seq, kind, payload: {} });
      expect(ack).toEqual({ accepted: true, duplicate: false });
    }
  });

  it("reports a replayed seq as a duplicate instead of an error — delivery is at-least-once", async () => {
    const job = await claimOne();
    await client.event(job, { seq: 4, kind: "step_finished", payload: {} });
    expect(await client.event(job, { seq: 4, kind: "step_finished", payload: {} })).toEqual({ accepted: true, duplicate: true });
  });

  it("refuses an event kind outside the closed set before opening a socket", async () => {
    const job = await claimOne();
    const before = cp.calls.length;
    await expect(
      client.event(job, { seq: 1, kind: "step_exploded" as (typeof RUN_EVENT_KIND_VALUES)[number], payload: {} }),
    ).rejects.toBeInstanceOf(FatalInfraError);
    expect(cp.calls).toHaveLength(before);
  });

  it("throws StaleEpochError on 409, carrying what the zombie is allowed to learn", async () => {
    const job = await claimOne();
    cp.currentEpoch = 9; // a reaper bumped the lease while the chain was running
    const error = await client.complete(job, { verdict: "passed", steps: [], artifacts: [] }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StaleEpochError);
    expect(error).toMatchObject({ jobRunId: job.jobRunId, sentEpoch: job.leaseEpoch, currentEpoch: 9, retryable: false });
  });

  it("never retries a STALE_EPOCH — one call, then stop", async () => {
    const job = await claimOne();
    cp.currentEpoch = 9;
    const before = cp.calls.length;
    await expect(client.jobHeartbeat(job)).rejects.toBeInstanceOf(StaleEpochError);
    expect(cp.calls.length - before).toBe(1);
    expect(slept).toEqual([]);
  });

  it("tells the two 410 answers apart: cancelled run vs job already finished", async () => {
    const job = await claimOne();
    cp.forced.push({ status: 410, code: "JOB_CANCELLED" });
    await expect(client.jobHeartbeat(job)).rejects.toBeInstanceOf(JobCancelledError);
    cp.forced.push({ status: 410, code: "JOB_TERMINAL" });
    await expect(client.jobHeartbeat(job)).rejects.toBeInstanceOf(JobTerminalError);
  });

  it("raises the contract's own UnauthorizedError on 401 and does not retry it", async () => {
    const job = await claimOne();
    cp.forced.push({ status: 401, code: "UNAUTHORIZED" });
    const before = cp.calls.length;
    await expect(client.jobHeartbeat(job)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(cp.calls.length - before).toBe(1);
  });

  it("raises NotFoundError on 404 and does not retry it — the job is gone, not late", async () => {
    const job = await claimOne();
    cp.forced.push({ status: 404, code: "NOT_FOUND" });
    const before = cp.calls.length;
    await expect(client.jobHeartbeat(job)).rejects.toBeInstanceOf(NotFoundError);
    expect(cp.calls.length - before).toBe(1);
  });

  it("obeys Retry-After on a 429 instead of its own backoff", async () => {
    await client.register(registration);
    cp.forced.push({ status: 429, code: "RATE_LIMITED", headers: { "retry-after": "2" } });
    cp.nextJob = { chainKey: "login>checkout", plan };
    const job = await client.claim({ freeSlots: 4 });
    expect(job).not.toBeNull();
    expect(slept).toEqual([2_000]);
  });

  it("caps a hostile Retry-After at the lease it would otherwise outlive", async () => {
    await client.register(registration);
    cp.forced.push({ status: 429, code: "RATE_LIMITED", headers: { "retry-after": "86400" } });
    await client.claim({ freeSlots: 4 });
    expect(slept).toEqual([30_000]);
  });

  it("retries a 5xx with exponential backoff and succeeds", async () => {
    await client.register(registration);
    cp.forced.push({ status: 503 }, { status: 503 });
    cp.nextJob = { chainKey: "login>checkout", plan };
    expect(await client.claim({ freeSlots: 4 })).not.toBeNull();
    expect(slept).toHaveLength(2);
    expect(slept[0]).toBeGreaterThanOrEqual(200);
    expect(slept[1]).toBeGreaterThanOrEqual(400);
  });

  it("gives up after maxAttempts with a RETRYABLE network infra error", async () => {
    const attempts = 3;
    const limited = new HttpControlPlaneClient({
      baseUrl: cp.url,
      bootstrapToken: FAKE_BOOTSTRAP_TOKEN,
      maxAttempts: attempts,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    cp.forced.push({ status: 503 }, { status: 503 }, { status: 503 });
    const error = await limited.register(registration).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RetryableInfraError);
    expect(error).toMatchObject({ code: "network", retryable: true });
    expect(cp.calls).toHaveLength(attempts);
    // One sleep BETWEEN attempts, never after the last one — waiting to then give up is dead time.
    expect(slept).toHaveLength(attempts - 1);
  });

  it("returns a presigned target plus the artifactId the step gallery links to", async () => {
    const job = await claimOne();
    const ticket = await client.artifactTicket(job, {
      kind: "screenshot",
      contentType: "image/webp",
      sha256: sha,
      sizeBytes: 3304,
    });
    expect(ticket.method).toBe("PUT");
    expect(ticket.url).toContain(`/blob/${sha}`);
    expect(ticket.headers["Content-Type"]).toBe("image/webp");
    expect(ticket.artifactId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses to ASK for a ticket above the contract's size ceiling — no socket, no 400", async () => {
    const job = await claimOne();
    const before = cp.calls.length;
    const error = await client
      .artifactTicket(job, {
        kind: "trace",
        contentType: "application/zip",
        sha256: sha,
        sizeBytes: ARTIFACT_MAX_SIZE_BYTES + 1,
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FatalInfraError);
    expect(cp.calls).toHaveLength(before);
  });

  it("carries the four presentation fields of every step to complete — the gallery depends on them", async () => {
    const job = await claimOne();
    await client.complete(job, {
      verdict: "failed",
      steps: [
        {
          caseId,
          ordinal: 1,
          status: "failed",
          durationMs: 812,
          renderedSentence: 'Click "Checkout"',
          failureContext: { expected: "cart", actual: "login" },
          screenshotArtifactId: "44444444-4444-4444-8444-444444444444",
          thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
        },
      ],
      artifacts: [{ kind: "screenshot_bundle", sha256: sha, sizeBytes: 3304 }],
    });
    const steps = cp.calls.at(-1)?.body["steps"];
    expect(steps).toMatchObject([
      {
        renderedSentence: 'Click "Checkout"',
        failureContext: { expected: "cart", actual: "login" },
        screenshotArtifactId: "44444444-4444-4444-8444-444444444444",
        thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
      },
    ]);
  });

  it("defaults the four presentation fields rather than omitting them when a step has none", async () => {
    const job = await claimOne();
    await client.complete(job, {
      verdict: "passed",
      steps: [{ caseId, ordinal: 1, status: "passed", durationMs: 91 }],
      artifacts: [],
    });
    expect(cp.calls.at(-1)?.body["steps"]).toMatchObject([
      { renderedSentence: "", failureContext: null, screenshotArtifactId: null, thumbhash: null },
    ]);
  });

  it("reports an infra failure through fail(), never as a verdict", async () => {
    const job = await claimOne();
    const ack = await client.fail(job, {
      code: "browser_oom",
      retryable: true,
      message: "chromium killed by cgroup",
      peakRssBytes: 1_728_053_248,
    });
    const call = cp.calls.at(-1);
    expect(call?.path).toContain("/complete");
    expect(call?.body["infraError"]).toMatchObject({ code: "browser_oom", peakRssBytes: 1_728_053_248 });
    expect(call?.body["verdict"]).toBeUndefined();
    expect(ack.requeued).toBe(true);
  });

  it("refuses an infra code outside the contract's five, before opening a socket", async () => {
    const job = await claimOne();
    const before = cp.calls.length;
    await expect(
      client.fail(job, { code: "disk_full" as "browser_oom", retryable: true, message: "nope" }),
    ).rejects.toBeInstanceOf(FatalInfraError);
    expect(cp.calls).toHaveLength(before);
  });

  it("relays a drain command from the worker heartbeat", async () => {
    await client.register(registration);
    cp.workerCommand = "drain";
    const answer = await client.workerHeartbeat({ freeSlots: 2, psi: { some10: 12.5, full10: 0.4 }, rssBytes: 95_000_000 });
    expect(answer.command).toBe("drain");
    expect(cp.calls.at(-1)?.path).toBe("/internal/fleet/workers/host1-w1/heartbeat");
  });

  it("relays a cancel command from the job heartbeat", async () => {
    const job = await claimOne();
    cp.jobCommand = "cancel";
    expect(await client.jobHeartbeat(job)).toMatchObject({ command: "cancel" });
  });
});

/**
 * DRIFT GUARD for the one payload the worker is most tempted to re-type by hand.
 *
 * Why a source assertion and not a type assertion: TypeScript is structural, so a hand-written
 * `interface ClaimedJob` listing today's ten fields is INDISTINGUISHABLE — at compile time and at
 * runtime — from the type derived off `claimedJobSchema`. The two only diverge the day the
 * contract gains a field: the derived type carries it, the hand-written one drops it silently at
 * the object literal that builds the job. There is nothing to observe until that day, which is
 * exactly why the guard is placed on the DECLARATION instead of on behaviour.
 *
 * What is proven here: this worker's own declaration and its own claim path. That the control
 * plane actually serves `claimedJobSchema` is proven by `apps/core`'s internal-route suites.
 */
describe("ClaimedJob stays derived from the contract", () => {
  const clientSource = readFileSync(fileURLToPath(new URL("../src/control-plane-client.ts", import.meta.url)), "utf8");

  it("declares ClaimedJob off claimedJobSchema instead of re-listing the payload's fields", () => {
    expect(clientSource).toMatch(/export type ClaimedJob =[^;]*z\.infer<typeof claimedJobSchema>/u);
    expect(clientSource).not.toMatch(/interface ClaimedJob\b/u);
  });

  it("hands back every field claimedJobSchema declares, so a field added over there is never dropped here", async () => {
    const job = await claimOne();
    expect(Object.keys(job).sort()).toEqual(Object.keys(claimedJobSchema.shape).sort());
  });
});
