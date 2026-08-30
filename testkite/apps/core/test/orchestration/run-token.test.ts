/**
 * Fleet credentials — the two tokens a zero-credential worker is ever allowed to hold.
 *
 * What this proves is the SHAPE OF THE BLAST RADIUS, not just "the round trip works":
 *  - a WORKER token names one worker and one lane, and rotating it (a restart) kills the
 *    previous one on the spot, so a dead container's credential never outlives it;
 *  - a RUN token names exactly one (job_run, attempt, lease_epoch), carries no scopes, no
 *    role and no user, expires with the lease and is revoked the moment ownership moves.
 * Both are stored as SHA-256 only — the same discipline as api_tokens (M2).
 *
 * Deliberate deviations from the plan's block (Task 9, Step 1):
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as dispatcher-lease.test.ts / job-queue.test.ts).
 *  - "rejects a malformed token" runs against a POISONED db handle: asserting `null` against a
 *    live handle would pass just as well if the lookup had happened, which is the opposite of
 *    what the test claims to show.
 *  - five tests the plan leaves out: the two GRANTs (the request path must not even be able to
 *    LOOK at the fleet roster; the auth path may read a run token but never write one), a
 *    cross-tenant revoke, an expired WORKER token, and the L1 fail-closed check on minting.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TkDb } from "../../src/modules/kernel/index.js";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import {
  WORKER_TOKEN_TTL_HOURS,
  mintRunToken,
  registerWorker,
  revokeRunTokensFor,
  touchWorker,
  verifyRunToken,
  verifyWorkerToken,
} from "../../src/modules/orchestration/run-token.js";

const now = new Date("2026-08-30T09:00:00Z");
const later = new Date(now.getTime() + 60_000);

/**
 * A handle that fails loudly if anything opens a transaction on it. The only way to show a
 * malformed token costs ZERO round trips: `toBeNull()` on a live handle would also pass if
 * the query had run and found nothing.
 */
/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>" — the Postgres message carrying the "permission denied" text lives in
 * `.cause`. So `rejects.toThrow(/permission denied/i)` would never match no matter how tight
 * the GRANT is; walk the whole cause chain instead (same helper as job-runs-schema.test.ts).
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

/**
 * The random body of a secret: everything after `tk?_<prefix>_`.
 *
 * NOT `secret.split("_")[2]`, which is what the plan's block wrote and which is only
 * INTERMITTENTLY correct — base64url uses "_" as one of its own characters, so that
 * expression can hand back a one-character fragment such as "5", and every JSON dump on
 * earth contains a "5". Measured: the plan's shape passed on one run and failed on the next.
 */
function secretBody(secret: string): string {
  const body = /^tk[rw]_[0-9a-f]{8}_(.+)$/.exec(secret)?.[1];
  if (body === undefined) throw new Error(`minted secret has an unexpected shape: ${secret}`);
  // A fragment shorter than the full 32-byte body would make "not to contain" trivially true.
  if (body.length < 20) throw new Error("secret body is too short to assert anything about");
  return body;
}

const poisonedDb = {
  transaction: (): never => {
    throw new Error("a malformed token must be rejected before any DB round trip");
  },
} as unknown as TkDb;

describe("fleet credentials", () => {
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

  it("register hands back a worker token scoped to that worker only", async () => {
    const r = await registerWorker(t.db, {
      workerId: "w1",
      hostname: "h1",
      lane: "batch",
      capacity: 4,
      now,
    });
    expect(r.workerToken).toMatch(/^tkw_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/);
    expect(await verifyWorkerToken(t.db, r.workerToken, now)).toMatchObject({
      workerId: "w1",
      lane: "batch",
      capacity: 4,
    });
  });

  it("register is idempotent: re-registering the same worker rotates the token, never duplicates the row", async () => {
    const first = await registerWorker(t.db, {
      workerId: "w1",
      hostname: "h1",
      lane: "batch",
      capacity: 4,
      now,
    });
    const second = await registerWorker(t.db, {
      workerId: "w1",
      hostname: "h1",
      lane: "batch",
      capacity: 4,
      now,
    });
    expect(second.workerToken).not.toBe(first.workerToken);
    // The old token dies at once — a restarted worker must not leave a usable credential behind.
    expect(await verifyWorkerToken(t.db, first.workerToken, now)).toBeNull();
    expect(await t.countRows("orc_workers")).toBe(1);
  });

  it("tells a draining worker to stop taking work", async () => {
    await registerWorker(t.db, { workerId: "w1", hostname: "h1", lane: "batch", capacity: 4, now });
    await t.setWorkerDrain("w1", true);
    expect(await touchWorker(t.db, { workerId: "w1", freeSlots: 2, now })).toEqual({
      command: "drain",
    });
  });

  it("tells a worker that is no longer on the roster to stop, not to carry on", async () => {
    // DELIBERATE DEVIATION from the plan's block, which answered `continue` when nothing
    // matched: "carry on" is the one answer a machine the control plane no longer knows about
    // must never get. The heartbeat endpoint verifies the worker token against this same
    // table first, so reaching zero rows means the worker was deregistered mid-flight.
    expect(await touchWorker(t.db, { workerId: "ghost", freeSlots: 4, now })).toEqual({
      command: "drain",
    });
  });

  it("refuses a worker token past its 24h TTL", async () => {
    const r = await registerWorker(t.db, {
      workerId: "w1",
      hostname: "h1",
      lane: "batch",
      capacity: 4,
      now,
    });
    const afterTtl = new Date(now.getTime() + (WORKER_TOKEN_TTL_HOURS + 1) * 3_600_000);
    expect(await verifyWorkerToken(t.db, r.workerToken, afterTtl)).toBeNull();
  });

  it("keeps the fleet roster away from the request path entirely", async () => {
    // orc_workers is not tenant data and has no RLS, so the GRANT is the ONLY thing between a
    // leaked request-path connection and the worker credentials sitting in this table.
    const msg = await rejectionMessage(() =>
      t.asTeam(a.teamId, (db) => db.execute(sql`SELECT id FROM orc_workers`)),
    );
    expect(msg).toMatch(/permission denied for table orc_workers/i);
  });

  it("run token round-trips the scope it was minted with", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: later,
      }),
    );
    expect(minted.secret).toMatch(/^tkr_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/);
    expect(await verifyRunToken(t.db, minted.secret, now)).toMatchObject({
      teamId: a.teamId,
      jobRunId: job.jobRunId,
      attempt: 1,
      leaseEpoch: 1,
    });
  });

  it("stores only a hash — neither secret ever reaches the database in the clear", async () => {
    const worker = await registerWorker(t.db, {
      workerId: "w1",
      hostname: "h1",
      lane: "batch",
      capacity: 4,
      now,
    });
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: later,
      }),
    );
    expect(JSON.stringify(await t.dumpTable("orc_run_tokens"))).not.toContain(
      secretBody(minted.secret),
    );
    expect(JSON.stringify(await t.dumpTable("orc_workers"))).not.toContain(
      secretBody(worker.workerToken),
    );
  });

  it("refuses an expired run token", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: new Date(now.getTime() - 1_000),
      }),
    );
    expect(await verifyRunToken(t.db, minted.secret, now)).toBeNull();
  });

  it("refuses a run token whose job was requeued (revoked on epoch bump)", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: later,
      }),
    );
    await t.asTeamCtx(a.teamId, (tx, ctx) => revokeRunTokensFor(tx, ctx, job.jobRunId));
    expect(await verifyRunToken(t.db, minted.secret, now)).toBeNull();
  });

  it("cannot be revoked by another tenant — a foreign revoke touches nothing", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: later,
      }),
    );
    await t.asTeamCtx(b.teamId, (tx, ctx) => revokeRunTokensFor(tx, ctx, job.jobRunId));
    expect(await verifyRunToken(t.db, minted.secret, now)).not.toBeNull();
  });

  it("carries no team scopes at all — a run token is not a team credential", async () => {
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      mintRunToken(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        leaseEpoch: 1,
        workerId: "w1",
        expiresAt: later,
      }),
    );
    const scope = await verifyRunToken(t.db, minted.secret, now);
    // No `scopes`, no `role`, no `userId`. If a future change adds one, this test is the
    // tripwire: the worker would suddenly be able to act as the tenant.
    expect(Object.keys(scope ?? {}).sort()).toEqual([
      "attempt",
      "jobRunId",
      "leaseEpoch",
      "teamId",
      "tokenId",
    ]);
  });

  it("mints nothing without a tenant context — L1 fail-closed", async () => {
    const job = await t.seedClaimedJob(a);
    await expect(
      t.asTeamCtx(a.teamId, (tx) =>
        mintRunToken(
          tx,
          { teamId: "" },
          {
            jobRunId: job.jobRunId,
            attempt: 1,
            leaseEpoch: 1,
            workerId: "w1",
            expiresAt: later,
          },
        ),
      ),
    ).rejects.toThrow(/Invalid TenantContext/);
  });

  it("lets the auth path READ a run token but never write one", async () => {
    // Verification happens BEFORE the tenant is known, so testkite_auth needs SELECT through
    // the auth_lookup policy — and nothing else. A revoke that could be issued by the auth
    // role would be a way to disown a running job without holding any tenant credential.
    const msg = await rejectionMessage(() =>
      t.asAuthRole((db) => db.execute(sql`UPDATE orc_run_tokens SET revoked_at = now()`)),
    );
    expect(msg).toMatch(/permission denied for table orc_run_tokens/i);
  });

  it("rejects a malformed token without touching the database", async () => {
    expect(await verifyRunToken(poisonedDb, "tk_deadbeef_notarunt0ken", now)).toBeNull();
    expect(await verifyWorkerToken(poisonedDb, "tkr_deadbeef_wrongkind", now)).toBeNull();
  });
});
