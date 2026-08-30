/**
 * `orc_run_events` — the worker's narration of a chain, and the only thing the SSE stream
 * (Task 14) will ever replay from.
 *
 * The subject here is IDEMPOTENCE AS A CONSTRAINT, not as application logic: a worker
 * delivers at-least-once, so a replayed `seq` is normal traffic and must be answered with
 * "accepted, duplicate" — never an error, and never a second row. The unique key carries
 * `attempt` because attempt 2 legitimately restarts its narration at seq 1.
 *
 * Deliberate deviations from the plan's block (Task 10, Step 1):
 *  - makeTestDb() once in beforeAll + reset() per test — migrate() costs ~3.6s, TRUNCATE ~2ms
 *    (same shape as run-token.test.ts / job-queue.test.ts).
 *  - six tests the plan leaves out: the closed 7-value `kind` enum and the `seq >= 1` guard at
 *    the STORAGE layer (a worker is the one choosing both, so a zod schema in the HTTP layer
 *    is a second line of defence, not the only one), the append-only GRANT, the resume cursor
 *    `afterSeqByJob` that SSE depends on, a cross-tenant write, and the L1 fail-closed check.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type SeededTeam, type TestDb } from "../harness/pglite.js";
import { readRunEvents, recordRunEvent } from "../../src/modules/orchestration/events.js";

/**
 * drizzle-orm 0.45 wraps the driver error in `DrizzleQueryError`: `.message` is only
 * "Failed query: <sql>" — the Postgres message carrying the constraint name or the
 * "permission denied" text lives in `.cause`. So `rejects.toThrow(/foreign key/i)` would
 * never match no matter how correct the schema is; walk the whole cause chain instead
 * (same helper as job-runs-schema.test.ts and run-token.test.ts).
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

describe("run events", () => {
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

  it("accepts a new seq and reports a replay as a duplicate, not an error", async () => {
    const job = await t.seedClaimedJob(a);
    const ev = {
      jobRunId: job.jobRunId,
      attempt: 1,
      seq: 1,
      kind: "step_started" as const,
      payload: { ordinal: 1 },
    };
    expect(await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, ev))).toEqual({
      accepted: true,
      duplicate: false,
    });
    // A worker retrying after a network blip must not be punished — and must not double-write.
    expect(await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, ev))).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(await t.countRows("orc_run_events")).toBe(1);
  });

  it("keeps the FIRST write for a seq — a later, different payload cannot rewrite history", async () => {
    const job = await t.seedClaimedJob(a);
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        seq: 1,
        kind: "step_finished",
        payload: { verdict: "passed" },
      }),
    );
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        seq: 1,
        kind: "step_finished",
        payload: { verdict: "failed" },
      }),
    );
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, { runId: job.runId }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ verdict: "passed" });
  });

  it("accepts events out of order and reports them back in seq order", async () => {
    const job = await t.seedClaimedJob(a);
    for (const seq of [3, 1, 2]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        recordRunEvent(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: 1,
          seq,
          kind: "step_started",
          payload: {},
        }),
      );
    }
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, { runId: job.runId }),
    );
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps attempt 2's events separate from attempt 1's — the same seq means a different event", async () => {
    const job = await t.seedClaimedJob(a);
    for (const attempt of [1, 2]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        recordRunEvent(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt,
          seq: 1,
          kind: "chain_started",
          payload: { attempt },
        }),
      );
    }
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, { runId: job.runId }),
    );
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("never returns another team's events", async () => {
    const job = await t.seedClaimedJob(a);
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        seq: 1,
        kind: "chain_started",
        payload: {},
      }),
    );
    const seen = await t.asTeamCtx(b.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, { runId: job.runId }),
    );
    expect(seen).toEqual([]);
  });

  it("resumes from a per-job cursor — an SSE reconnect replays nothing it already sent", async () => {
    const job = await t.seedClaimedJob(a);
    for (const seq of [1, 2, 3]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) =>
        recordRunEvent(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: 1,
          seq,
          kind: "step_finished",
          payload: { ordinal: seq },
        }),
      );
    }
    const tail = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, {
        runId: job.runId,
        afterSeqByJob: new Map([[job.jobRunId, 2]]),
      }),
    );
    expect(tail.map((e) => e.seq)).toEqual([3]);
    // A cursor naming a DIFFERENT job must not silence this one — the map is per job, not global.
    const untouched = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      readRunEvents(tx, ctx, {
        runId: job.runId,
        afterSeqByJob: new Map([["00000000-0000-4000-8000-0000000000ff", 99]]),
      }),
    );
    expect(untouched.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("refuses a kind outside the closed seven — the enum is a CHECK, not a convention", async () => {
    const job = await t.seedClaimedJob(a);
    // Written on the OWNER connection on purpose: this asserts the STORAGE layer refuses it,
    // independently of whatever the HTTP layer's zod schema does with the same value.
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`
        INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, kind)
        VALUES (${a.teamId}, ${job.jobRunId}, 1, 1, 'rm_minus_rf')`),
    );
    expect(msg).toMatch(/orc_run_events_kind_check|check constraint/i);
  });

  it("refuses seq 0 — a worker numbering its narration from zero is a bug, not a new convention", async () => {
    const job = await t.seedClaimedJob(a);
    const msg = await rejectionMessage(() =>
      t.db.execute(sql`
        INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, kind)
        VALUES (${a.teamId}, ${job.jobRunId}, 1, 0, 'chain_started')`),
    );
    expect(msg).toMatch(/orc_run_events_seq_check|check constraint/i);
  });

  it("is append-only at the privilege layer: the request path may INSERT and SELECT, nothing else", async () => {
    const grants = await t.db.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'testkite_app' AND table_schema = 'public'
        AND table_name = 'orc_run_events'`);
    expect(new Set(grants.rows.map((r) => String(r["privilege_type"])))).toEqual(
      new Set(["SELECT", "INSERT"]),
    );
    // The catalog is the declaration; this is the engine enforcing it. Evidence a worker
    // produced must not be editable by the very path that serves that worker's requests.
    const job = await t.seedClaimedJob(a);
    await t.asTeamCtx(a.teamId, (tx, ctx) =>
      recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId,
        attempt: 1,
        seq: 1,
        kind: "infra_error",
        payload: { code: "browser_oom" },
      }),
    );
    expect(
      await rejectionMessage(() =>
        t.asTeam(a.teamId, (tx) => tx.execute(sql`UPDATE orc_run_events SET kind = 'screenshot'`)),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await rejectionMessage(() =>
        t.asTeam(a.teamId, (tx) => tx.execute(sql`DELETE FROM orc_run_events`)),
      ),
    ).toMatch(/permission denied/i);
  });

  it("cannot narrate another team's job — the composite FK makes it unrepresentable", async () => {
    const job = await t.seedClaimedJob(a);
    const msg = await rejectionMessage(() =>
      t.asTeamCtx(b.teamId, (tx, ctx) =>
        recordRunEvent(tx, ctx, {
          jobRunId: job.jobRunId,
          attempt: 1,
          seq: 1,
          kind: "chain_started",
          payload: {},
        }),
      ),
    );
    expect(msg).toMatch(/orc_run_events_job_fk|foreign key/i);
  });

  it("records nothing without a tenant context — L1 fail-closed", async () => {
    const job = await t.seedClaimedJob(a);
    await expect(
      t.asTeamCtx(a.teamId, (tx) =>
        recordRunEvent(
          tx,
          { teamId: "" },
          { jobRunId: job.jobRunId, attempt: 1, seq: 1, kind: "chain_started", payload: {} },
        ),
      ),
    ).rejects.toThrow(/Invalid TenantContext/);
    expect(await t.countRows("orc_run_events")).toBe(0);
  });
});
