/**
 * THE RUN TOKEN'S LIFETIME MUST FOLLOW THE LEASE, NOT THE CLAIM.
 *
 * A run token is minted at claim time with `expires_at = lease_expires_at + 60s`, i.e. 90
 * seconds after the claim (LEASE_SECONDS = 30, RUN_TOKEN_TTL_SLACK_SECONDS = 60). The lease
 * itself is renewed by every job heartbeat, so a chain that beats every 5s keeps the lease
 * alive for as long as it runs — and the chain budget reaches 900s. Without a renewal of the
 * token's own `expires_at`, the credential dies 90 seconds after the claim while the worker is
 * still the rightful owner: from there every call is 401, which tells the worker its credential
 * is broken and it should exit and re-register, over a job that is running perfectly.
 *
 * The suite proves the renewal three ways, deliberately at different altitudes:
 *  - the module function, with an explicit clock, so the TTL arithmetic is pinned exactly;
 *  - the wire, over a chain that outlives the claim-time TTL by twice its length;
 *  - and the docstring of `revokeRunTokensFor`, which claims a set of callers the source has to
 *    actually contain (a comment nobody checks is how a lie survives a milestone).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eventResponseSchema,
  jobHeartbeatResponseSchema,
  completeResponseSchema,
} from "@testkite/contract";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  closeInternalTestApp,
  makeInternalTestApp,
  type InternalTestApp,
} from "../harness/internal.js";
import {
  RUN_TOKEN_TTL_SLACK_SECONDS,
  mintRunToken,
  renewRunTokenTtl,
  revokeRunTokensFor,
  verifyRunToken,
} from "../../src/modules/orchestration/run-token.js";
import { LEASE_SECONDS } from "../../src/modules/orchestration/queue/job-queue.js";

const now = new Date("2026-08-31T09:00:00Z");
/** The deadline a claim stamps: one lease, plus the slack that lets a late heartbeat still authenticate. */
const claimTimeExpiry = new Date(
  now.getTime() + (LEASE_SECONDS + RUN_TOKEN_TTL_SLACK_SECONDS) * 1_000,
);
/** Past the claim-time TTL, and well inside a 900s chain budget. */
const wayLater = new Date(now.getTime() + 300_000);

/** Both drivers hand a timestamptz back as a Date; PGlite's raw path can hand back the text. */
const asTime = (value: unknown): number =>
  value instanceof Date ? value.getTime() : Date.parse(String(value));

describe("renewRunTokenTtl", () => {
  let t: TestDb;
  let a: SeededTeam;
  let b: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a, b] = await t.seedTwoTeams();
  });

  it("pushes expires_at to the NEW lease deadline plus the slack, so the token outlives the claim", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: job.attempt,
        leaseEpoch: job.leaseEpoch,
        workerId: "w1",
        expiresAt: claimTimeExpiry,
      }),
    );
    // The starting point: dead 90s after the claim, which is what makes the renewal necessary.
    expect(await verifyRunToken(t.db, minted.secret, wayLater)).toBeNull();

    const renewedLease = new Date(wayLater.getTime() + LEASE_SECONDS * 1_000);
    const renewed = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      renewRunTokenTtl(tx, ctx, {
        jobRunId: job.jobRunId,
        leaseEpoch: job.leaseEpoch,
        leaseExpiresAt: renewedLease,
      }),
    );
    expect(renewed).toBe(1);

    expect(await verifyRunToken(t.db, minted.secret, wayLater)).toMatchObject({
      jobRunId: job.jobRunId,
      leaseEpoch: job.leaseEpoch,
    });
    // Exactly the lease deadline plus the slack — the same arithmetic the claim path uses, so
    // the token can never outlive the lease by more than the one minute that is documented.
    const stored = await t.dumpTable("orc_run_tokens");
    expect(asTime(stored[0]?.["expires_at"])).toBe(
      renewedLease.getTime() + RUN_TOKEN_TTL_SLACK_SECONDS * 1_000,
    );
  });

  it("renews NOTHING for a stale epoch — a fenced worker cannot extend its own credential", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: job.attempt,
        leaseEpoch: job.leaseEpoch,
        workerId: "w1",
        expiresAt: claimTimeExpiry,
      }),
    );
    const renewed = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      renewRunTokenTtl(tx, ctx, {
        jobRunId: job.jobRunId,
        leaseEpoch: job.leaseEpoch + 1,
        leaseExpiresAt: new Date(wayLater.getTime() + LEASE_SECONDS * 1_000),
      }),
    );
    expect(renewed).toBe(0);
    expect(await verifyRunToken(t.db, minted.secret, wayLater)).toBeNull();
  });

  it("never resurrects a REVOKED token, however long the lease is renewed for", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: job.attempt,
        leaseEpoch: job.leaseEpoch,
        workerId: "w1",
        expiresAt: claimTimeExpiry,
      }),
    );
    await t.asTeamCtx(a.teamId, (tx, ctx) => revokeRunTokensFor(tx, ctx, job.jobRunId));

    const renewed = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      renewRunTokenTtl(tx, ctx, {
        jobRunId: job.jobRunId,
        leaseEpoch: job.leaseEpoch,
        leaseExpiresAt: new Date(wayLater.getTime() + LEASE_SECONDS * 1_000),
      }),
    );
    expect(renewed).toBe(0);
    expect(await verifyRunToken(t.db, minted.secret, now)).toBeNull();
  });

  it("is tenant-scoped — another team's renewal touches nothing", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: job.attempt,
        leaseEpoch: job.leaseEpoch,
        workerId: "w1",
        expiresAt: claimTimeExpiry,
      }),
    );
    const renewed = await t.asTeamCtx(b.teamId, (tx, ctx) =>
      renewRunTokenTtl(tx, ctx, {
        jobRunId: job.jobRunId,
        leaseEpoch: job.leaseEpoch,
        leaseExpiresAt: new Date(wayLater.getTime() + LEASE_SECONDS * 1_000),
      }),
    );
    expect(renewed).toBe(0);
    expect(await verifyRunToken(t.db, minted.secret, wayLater)).toBeNull();
  });

  it("mints nothing without a tenant context — L1 fail-closed", async () => {
    const job = await t.seedClaimedJob(a);
    await expect(
      t.asTeamCtx(a.teamId, (tx) =>
        renewRunTokenTtl(
          tx,
          { teamId: "" },
          {
            jobRunId: job.jobRunId,
            leaseEpoch: job.leaseEpoch,
            leaseExpiresAt: claimTimeExpiry,
          },
        ),
      ),
    ).rejects.toThrow(/Invalid TenantContext/);
  });
});

describe("run token lifetime on the wire", () => {
  let h: InternalTestApp;

  beforeEach(async () => {
    h = await makeInternalTestApp();
  });
  afterAll(async () => {
    await closeInternalTestApp();
  });

  /**
   * Three rewinds of 60s = 180 simulated seconds, twice the 90s a claim buys. Each step is
   * SHORTER than the TTL on purpose: a worker beating every 5s never lets the credential lapse,
   * so this is the real shape of a long chain, not a resurrection.
   */
  const STEP_SECONDS = 60;
  const STEPS = 3;

  it("a job heartbeat renews the credential, so a chain longer than the claim TTL keeps authenticating", async () => {
    const job = await h.claimOneJob();
    const atClaim = await h.runTokenExpiry(job.jobRunId);
    expect(atClaim.getTime() - Date.parse(job.leaseDeadlineAt)).toBe(
      RUN_TOKEN_TTL_SLACK_SECONDS * 1_000,
    );

    for (let step = 0; step < STEPS; step += 1) {
      await h.rewindFleetClock(STEP_SECONDS);
      const beat = await h.post(
        `/internal/fleet/jobs/${job.jobRunId}/heartbeat`,
        { leaseEpoch: job.leaseEpoch },
        job.runToken,
      );
      expect(beat.statusCode).toBe(200);
      expect(jobHeartbeatResponseSchema.parse(beat.json()).command).toBe("continue");
      // The renewal is what the next iteration depends on: after the rewind the token would
      // otherwise be `atClaim - 120s`, i.e. already expired, and the heartbeat would 401.
      const renewed = await h.runTokenExpiry(job.jobRunId);
      expect(renewed.getTime()).toBeGreaterThan(Date.now());
    }

    // `verifyRunToken` speaking through the auth hook: 202 is only reachable if the credential
    // minted 180 simulated seconds ago still resolves to this job's scope.
    const event = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/events`,
      { leaseEpoch: job.leaseEpoch, seq: 1, kind: "chain_started", payload: {} },
      job.runToken,
    );
    expect(event.statusCode).toBe(202);
    expect(eventResponseSchema.parse(event.json())).toMatchObject({ accepted: true });
  });

  it("completes a 180s chain with 200, not the 401 a credential frozen at claim time would give", async () => {
    const job = await h.claimOneJob();
    for (let step = 0; step < STEPS; step += 1) {
      await h.rewindFleetClock(STEP_SECONDS);
      const beat = await h.post(
        `/internal/fleet/jobs/${job.jobRunId}/heartbeat`,
        { leaseEpoch: job.leaseEpoch },
        job.runToken,
      );
      expect(beat.statusCode).toBe(200);
    }

    const done = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/complete`,
      { leaseEpoch: job.leaseEpoch, verdict: "passed", steps: [h.sampleStep()], artifacts: [] },
      job.runToken,
    );
    expect(done.statusCode).toBe(200);
    expect(completeResponseSchema.parse(done.json())).toMatchObject({ ok: true, requeued: false });
    expect(await h.caseResultCount(job.jobRunId)).toBe(1);
  });

  it("still expires a token whose lease stopped being renewed — the TTL follows the lease, it is not removed", async () => {
    const job = await h.claimOneJob();
    // No heartbeat at all: 120s of silence is past the 90s the claim bought.
    await h.rewindFleetClock(120);
    const beat = await h.post(
      `/internal/fleet/jobs/${job.jobRunId}/heartbeat`,
      { leaseEpoch: job.leaseEpoch },
      job.runToken,
    );
    expect(beat.statusCode).toBe(401);
  });
});

/**
 * The docstring of `revokeRunTokensFor` names its callers. Callers are checkable, so they are
 * checked here rather than trusted: the sentence "reap, cancel, complete" survived the whole of
 * M3 while the only production call site was the infra-requeue branch of `internalComplete`.
 */
describe("revokeRunTokensFor call sites", () => {
  const SRC = fileURLToPath(new URL("../../src", import.meta.url));

  const walk = (dir: string): readonly string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".ts") ? [full] : [];
    });

  it("has exactly ONE production call site, in the internal fleet plane", () => {
    const callSites = walk(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ file, line: i + 1, text: line }))
        // The declaration itself is not a call, and neither is the facade's re-export.
        .filter(
          ({ text }) =>
            /revokeRunTokensFor\(/.test(text) && !/export async function/.test(text),
        ),
    );
    expect(callSites.map(({ file }) => file.slice(SRC.length))).toEqual([
      "/http/internal/routes.ts",
    ]);
  });
});
