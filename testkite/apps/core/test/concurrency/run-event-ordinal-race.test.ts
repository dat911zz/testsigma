/**
 * `orc_run_events.run_ordinal` under REAL contention — several connections, one run.
 *
 * WHY IT CANNOT LIVE IN THE PGlite LAYER: PGlite is a SINGLE wasm connection, so two
 * "concurrent" writers merely queue and the second always reads what the first has already
 * committed. The claim under test is precisely the one a single connection cannot disprove.
 *
 * WHAT THE ORDINAL HAS TO PROMISE. The SSE stream hands a client `id: <run_ordinal>` and
 * resumes with `WHERE run_ordinal > cursor`. That is only sound if ORDINAL ORDER IS COMMIT
 * ORDER: the instant a poller can see ordinal N, every ordinal below N must ALREADY be
 * visible, or the poller acks past an event that is still in flight and never looks at it
 * again. A bare `nextval` cannot promise that — the number is taken at statement time and the
 * transaction commits an unbounded moment later, so a lower number can surface after a higher
 * one has been delivered. `recordRunEvent` therefore allocates under the RUN ROW's lock, which
 * Postgres holds until commit: the transaction that takes ordinal N could only reach the
 * allocator after the holder of N-1 had already committed and let go. The second case below
 * measures exactly that — writer two BLOCKS rather than taking a number it could commit first.
 *
 * WHAT THE LOCK ORDER HAS TO PROMISE. That allocator is a second lock, taken by a transaction
 * that is already holding the JOB row (`fenceJob` does that on the events endpoint). `abortRun`
 * touches the same two rows. Both therefore take them in ONE order — job rows first, the run
 * row LAST — and the third case keeps that rule honest: with the two swapped, an abort racing a
 * worker's narration deadlocks (40P01) instead of serializing.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is
 * collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant, type TenantContext } from "../../src/modules/kernel/index.js";
import {
  readRunEvents,
  recordRunEvent,
  type RecordEventInput,
} from "../../src/modules/orchestration/events.js";
import { abortRun } from "../../src/modules/orchestration/run-service.js";
import { fenceJob } from "../../src/modules/orchestration/queue/job-queue.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;

/** A blocking gate: opens once `n` parties have arrived, so every transaction is OPEN first. */
function makeGate(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

/** A one-shot handoff: `wait` resolves once somebody calls `open`. */
function makeLatch(): { readonly wait: Promise<void>; readonly open: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait,
    open: (): void => {
      release();
    },
  };
}

describeRealPg("run-event ordinals under REAL contention (real Postgres, many connections)", () => {
  let r: RealDb;
  let teamId = "";
  let runId = "";
  let jobIds: string[] = [];

  const ctx = (): TenantContext => ({ teamId });

  const one = async (query: ReturnType<typeof sql>): Promise<string> => {
    const rows = await r.db.execute(query);
    const id: unknown = rows.rows[0]?.["id"];
    if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
    return id;
  };

  /**
   * Waits until SOME backend is parked on a lock it was refused. `pg_locks` rather than
   * `pg_stat_activity`: the latter blanks its columns for backends belonging to another role,
   * while `pg_locks` is visible to everyone — and "the writer is blocked" is the whole
   * observation these two cases rest on, so it must not depend on who connected.
   */
  const waitUntilSomebodyBlocks = async (): Promise<void> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const rows = await r.db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
      if (Number(rows.rows[0]?.["n"] ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("no backend ever blocked: the lock under test was never contended");
  };

  beforeAll(async () => {
    r = await makeRealDb();
    // Open every physical connection BEFORE any race: on a cold pool `Promise.all` is not
    // parallel at all — the second caller pays for TCP + auth and only reaches the table once
    // the first has COMMITted, which is a false green (see promote-lock.test.ts).
    const clients = await Promise.all(Array.from({ length: PARALLEL }, () => r.pool.connect()));
    for (const client of clients) client.release();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE orc_run_events, job_runs, orc_run_plans, orc_compile_diagnostics, orc_runs,
               quota_limits, memberships, projects, teams, users, organizations
      RESTART IDENTITY CASCADE`);
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    teamId = await one(
      sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId},'A','a') RETURNING id`,
    );
    const projectId = await one(
      sql`INSERT INTO projects (team_id, name, slug) VALUES (${teamId},'P','p') RETURNING id`,
    );
    const userId = await one(
      sql`INSERT INTO users (email, display_name) VALUES ('a@testkite.test','A') RETURNING id`,
    );
    runId = await one(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, status, requested_by, pin)
      VALUES (${teamId}, ${projectId}, 'batch', 'running', ${userId}, 'ready') RETURNING id`);
    jobIds = [];
    for (let i = 0; i < PARALLEL; i += 1) {
      jobIds.push(
        await one(sql`
          INSERT INTO job_runs (team_id, run_id, chain_key, status, lease_epoch)
          VALUES (${teamId}, ${runId}, ${`chain-${String(i)}`}, 'running', 1) RETURNING id`),
      );
    }
  });

  const chain = (i: number): string => {
    const id = jobIds[i];
    if (id === undefined) throw new Error(`seed: no chain ${String(i)}`);
    return id;
  };

  const eventOf = (jobRunId: string, seq: number): RecordEventInput => ({
    jobRunId,
    attempt: 1,
    seq,
    kind: "step_finished",
    payload: { seq },
  });

  it(`${String(PARALLEL)} chains narrating at once are numbered 1..${String(PARALLEL)}, once each`, async () => {
    const gate = makeGate(PARALLEL);
    await Promise.all(
      Array.from({ length: PARALLEL }, (_unused, i) =>
        withTenant(r.db, ctx(), async (tx) => {
          await gate();
          return recordRunEvent(tx, ctx(), eventOf(chain(i), 1));
        }),
      ),
    );

    const events = await withTenant(r.db, ctx(), (tx) => readRunEvents(tx, ctx(), { runId }));
    // Not merely distinct: exactly 1..N. Two writers sharing an ordinal would make one of them
    // invisible to every `> cursor` reader that had already acked the other.
    expect(events.map((e) => e.runOrdinal)).toEqual(
      Array.from({ length: PARALLEL }, (_unused, i) => i + 1),
    );
  }, 20_000);

  it("refuses to hand a second writer an ordinal while the first is still in flight", async () => {
    // THE PROPERTY A `nextval` CANNOT HAVE. With a bare sequence, writer two takes number 2
    // immediately and may commit BEFORE writer one — a poller then acks 2 and never sees 1.
    // Here writer two cannot even obtain a number until writer one has committed, so "I have
    // seen ordinal N" really does mean "everything below N is already on disk".
    const first = makeLatch();
    const firstAllocated = makeLatch();

    const writerOne = withTenant(r.db, ctx(), async (tx) => {
      const out = await recordRunEvent(tx, ctx(), eventOf(chain(0), 1));
      firstAllocated.open();
      // Still INSIDE the transaction: nothing it wrote is visible to anybody yet.
      await first.wait;
      return out;
    });

    await firstAllocated.wait;
    const writerTwo = withTenant(r.db, ctx(), (tx) => recordRunEvent(tx, ctx(), eventOf(chain(1), 1)));
    await waitUntilSomebodyBlocks();

    // The observer is a THIRD connection, and it must still see an empty run: writer one has
    // not committed, and writer two is parked on the allocator rather than racing past it.
    const midRace = await withTenant(r.db, ctx(), (tx) => readRunEvents(tx, ctx(), { runId }));
    expect(midRace, "an uncommitted narration must not be visible to a poller").toEqual([]);

    first.open();
    expect(await writerOne).toEqual({ accepted: true, duplicate: false });
    expect(await writerTwo).toEqual({ accepted: true, duplicate: false });

    const events = await withTenant(r.db, ctx(), (tx) => readRunEvents(tx, ctx(), { runId }));
    expect(events.map((e) => e.runOrdinal)).toEqual([1, 2]);
    // Ordinal order IS commit order: the one that committed first carries the lower number.
    expect(events.map((e) => e.jobRunId)).toEqual([chain(0), chain(1)]);
  }, 20_000);

  it("an abort racing a worker's narration serializes instead of deadlocking", async () => {
    // Both transactions touch the SAME two rows: this chain's job row and the run row. They
    // take them in one order — job first, run LAST — so one waits for the other. Reverse
    // either side and Postgres kills one of them with 40P01 (deadlock detected).
    const fenced = makeLatch();
    const abortBlocked = makeLatch();

    const narrating = withTenant(r.db, ctx(), async (tx) => {
      // The real events endpoint fences before it records; the fence takes the JOB row.
      await fenceJob(tx, ctx(), { jobRunId: chain(0), epoch: 1 });
      fenced.open();
      await abortBlocked.wait;
      return recordRunEvent(tx, ctx(), eventOf(chain(0), 1));
    });

    await fenced.wait;
    const aborting = withTenant(r.db, ctx(), (tx) => abortRun(tx, ctx(), { runId, now: new Date() }));
    // The abort is now parked on the job row the narration holds. Only THEN does the narration
    // reach for the run row — the moment a run-row-first abort would close the cycle.
    await waitUntilSomebodyBlocks();
    abortBlocked.open();

    const [recorded, aborted] = await Promise.all([narrating, aborting]);
    expect(recorded).toEqual({ accepted: true, duplicate: false });
    expect(aborted?.cancelledJobs).toBe(PARALLEL);

    const events = await withTenant(r.db, ctx(), (tx) => readRunEvents(tx, ctx(), { runId }));
    expect(events.map((e) => e.runOrdinal)).toEqual([1]);
  }, 20_000);
});
