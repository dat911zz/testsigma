/**
 * Migration 0042 — three index changes, each one asserted against `pg_indexes` rather than
 * against the migration file that wrote it. A migration is only ever true of the DATABASE, and
 * reading the DDL back is the only way to say so.
 *
 *  1. `job_runs_lease_idx` leads with `heartbeat_at`. Both of the reaper's statements filter
 *     `heartbeat_at < now() - ...` and NEITHER reads `lease_expires_at` — a lease deadline says
 *     when the owner agreed to stop, a heartbeat says when it last proved it was alive, and only
 *     the second detects a worker killed with -9. An index leading with the column nobody filters
 *     on is not the index the sweep uses.
 *  2. `usage_counters_team_idx` is gone: it was byte-for-byte the index Postgres already builds
 *     for the primary key `(team_id, metric, window_start)`, so it cost a second btree on every
 *     quota write and bought nothing.
 *  3. `orc_run_tokens` gains a PARTIAL unique key on `(team_id, job_run_id, attempt,
 *     lease_epoch) WHERE revoked_at IS NULL`. Partial is the whole point: two LIVE credentials
 *     for one lease is the state that would let a fenced worker keep writing, while re-minting
 *     after a revoke is normal and must stay legal.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import { mintRunToken, revokeRunTokensFor } from "../../src/modules/orchestration/run-token.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`, whose `.message` is only
 * "Failed query: <sql>" — the Postgres text lives on `.cause` (same helper as run-token.test.ts).
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
  throw new Error("the statement was expected to be rejected, but it succeeded");
}

describe("migration 0042 — index shapes", () => {
  let t: TestDb;
  let a: SeededTeam;

  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    [a] = await t.seedTwoTeams();
  });

  const indexDefs = async (table: string): Promise<ReadonlyMap<string, string>> => {
    const rows = await t.raw.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    return new Map(rows.rows.map((r) => [r.indexname, r.indexdef]));
  };

  it("the reaper's index leads with the column the reaper actually filters on", async () => {
    const def = (await indexDefs("job_runs")).get("job_runs_lease_idx");
    expect(def).toBeDefined();
    expect(def).toContain("heartbeat_at");
    // Still partial on `status = 'running'`: the sweep only ever looks at owned rows, and the
    // partial predicate is what keeps the btree the size of the running set, not of the table.
    expect(def).toMatch(/WHERE .*status.*=.*'running'/);
    // The old leading column is not merely demoted, it is gone: keeping it would be dead weight
    // on a write path (every heartbeat updates this row) for a filter nothing performs.
    expect(def).not.toContain("lease_expires_at");
  });

  it("drops the usage_counters index that duplicated its own primary key", async () => {
    const defs = await indexDefs("usage_counters");
    expect(defs.has("usage_counters_team_idx")).toBe(false);
    // The PK's own index still covers exactly those three columns in that order, which is why
    // the dropped one was never doing any work.
    const pk = defs.get("usage_counters_team_id_metric_window_start_pk");
    expect(pk).toBeDefined();
    expect(pk).toMatch(/\(team_id, metric, window_start\)/);
  });

  it("refuses a SECOND live run token for one (job, attempt, lease_epoch)", async () => {
    const job = await t.seedClaimedJob(a);
    const mint = (): Promise<unknown> =>
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        mintRunToken(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: job.attempt,
          leaseEpoch: job.leaseEpoch,
          workerId: "w1",
          expiresAt: new Date(Date.now() + 90_000),
        }),
      );
    await mint();
    // Two live credentials for one lease would mean a fenced worker could keep writing under a
    // second token nobody revoked. The database refuses it rather than trusting the claim path.
    expect(await rejectionMessage(mint)).toMatch(/orc_run_tokens_live_uidx/i);
  });

  it("still allows a re-mint after a revoke — the unique key is PARTIAL for exactly this", async () => {
    const job = await t.seedClaimedJob(a);
    const mint = (): Promise<{ readonly secret: string; readonly tokenId: string }> =>
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        mintRunToken(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: job.attempt,
          leaseEpoch: job.leaseEpoch,
          workerId: "w1",
          expiresAt: new Date(Date.now() + 90_000),
        }),
      );
    const first = await mint();
    await t.asTeamCtx(a.teamId, (tx, ctx) => revokeRunTokensFor(tx, ctx, job.jobRunId));
    const second = await mint();

    expect(second.tokenId).not.toBe(first.tokenId);
    // Both rows are still there — revoking is a tombstone, not a delete, so the history of who
    // held what stays readable.
    const rows = await t.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orc_run_tokens WHERE job_run_id = $1`,
      [job.jobRunId],
    );
    expect(rows.rows[0]?.n).toBe(2);
  });
});
