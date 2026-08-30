/**
 * `429 RATE_LIMITED` on `POST /internal/fleet/claim` under GENUINELY parallel requests — runs
 * ONLY on REAL Postgres.
 *
 * WHY IT CANNOT LIVE ON PGlite: the interesting question is not "does the counter count", which
 * a unit test answers (internal-claim-rate-limit.test.ts). It is what a fleet of workers hitting
 * one control plane at the same instant observes: PGlite is a SINGLE wasm connection, so every
 * "parallel" request there is really executed one after another and the claim query never has to
 * skip a locked row. A storm asserted on PGlite would prove that a queue of one connection hands
 * out each job once — which was never in doubt.
 *
 * Two regressions this file exists to catch, both invisible to the PGlite layer:
 *  1. the budget check moving to AFTER `claimJobs` (or into a transaction) — a throttled request
 *     would then swallow a job it never handed to anybody, and the chain would sit `running`
 *     with no worker until the reaper took it back 30s later;
 *  2. the budget being read and written across an `await` — under real parallelism the
 *     read-modify-write would interleave and a storm would spend far more than one burst.
 *
 * `warmPool` before every race for the reason promote-lock.test.ts documents: on a cold pool
 * `Promise.all` is not parallel at all, and a false green is worse than no test.
 *
 * No TESTKITE_TEST_PG_URL ⇒ the suite skips (`eval "$(scripts/test-pg.sh start)"` spins up a
 * throwaway cluster). The postgres:17 CI job always sets the var ⇒ CI is where proof is collected.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CLAIM_RATE_LIMIT_BURST, CLAIM_RATE_LIMIT_PER_SECOND } from "@testkite/contract";
import { buildInternalApp } from "../../src/http/internal/app.js";
import { dispatchPending } from "../../src/modules/orchestration/queue/job-queue.js";
import type { KernelEnv } from "../../src/modules/kernel/index.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Genuinely parallel connections. Equal to the harness pool's `max`, so nobody queues for one. */
const PARALLEL = 8;
/**
 * Requests one worker fires at once. Comfortably past a burst even after the refill that lands
 * while the storm is in flight, so "some request was throttled" is not a timing coin flip.
 */
const STORM = 50;
const BOOTSTRAP_TOKEN = "tkb_concurrency_bootstrap_secret";

/** Same shape the internal harness uses; kept local so a real-Postgres suite pulls in no PGlite. */
const ENV: KernelEnv = {
  NODE_ENV: "test",
  PORT: 8080,
  DATABASE_URL: "postgres://tk:pw@localhost:5432/testkite",
  DATABASE_APP_ROLE: "testkite_app",
  DATABASE_POOL_MAX: 10,
  LOG_LEVEL: "error",
  OIDC_DEV_MOCK: "0",
  DISPATCHER_ENABLED: false,
  DISPATCHER_ID: "test-dispatcher#1",
  S3_ENDPOINT: "http://minio.test:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET_ARTIFACTS: "artifacts",
  S3_ACCESS_KEY: "minioadmin",
  S3_SECRET_KEY: "minioadmin",
};

/** Opens `n` physical connections BEFORE the race, so `Promise.all` is parallel from the first ms. */
async function warmPool(pool: RealDb["pool"], n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

describeRealPg("claim storm under REAL parallelism (real Postgres, multiple connections)", () => {
  let r: RealDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    r = await makeRealDb();
    app = await buildInternalApp({
      env: ENV,
      db: r.db,
      bootstrapTokenHash: createHash("sha256").update(BOOTSTRAP_TOKEN).digest(),
    });
    await app.ready();
    await warmPool(r.pool, PARALLEL);
  });
  afterAll(async () => {
    await app.close();
    await r.close();
  });
  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE orc_run_tokens, orc_workers, job_runs, orc_run_plans, orc_compile_diagnostics,
               orc_runs, quota_limits, memberships, projects, teams, users, organizations
      RESTART IDENTITY CASCADE`);
  });

  /**
   * One tenant, one frozen plan, and `count` jobs already fanned out to `dispatched`. Written
   * with the owner connection on purpose: this is a fixture, not a path under test.
   */
  const seedDispatchedJobs = async (count: number): Promise<void> => {
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const rows = await r.db.execute(query);
      const id: unknown = rows.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
      return id;
    };
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
    );
    const teamId = await one(
      sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId}, 'A', 'a') RETURNING id`,
    );
    const projectId = await one(
      sql`INSERT INTO projects (team_id, name, slug) VALUES (${teamId}, 'P', 'p') RETURNING id`,
    );
    const userId = await one(
      sql`INSERT INTO users (email, display_name) VALUES ('a@testkite.test', 'A') RETURNING id`,
    );
    const runId = await one(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin, status)
      VALUES (${teamId}, ${projectId}, 'batch', ${userId}, 'ready', 'queued') RETURNING id`);
    // The claim reads this row and refuses to hand out a job without it (a job with no plan is
    // a control-plane bug, answered 500, never "here, run nothing").
    await r.db.execute(sql`
      INSERT INTO orc_run_plans (team_id, run_id, content_hash, plan_format_version, plan)
      VALUES (${teamId}, ${runId}, ${"a".repeat(64)}, 1, ${JSON.stringify({ chains: [] })}::jsonb)`);
    for (let i = 0; i < count; i += 1) {
      await r.db.execute(sql`
        INSERT INTO job_runs (team_id, run_id, chain_key)
        VALUES (${teamId}, ${runId}, ${`chain-${String(i)}`})`);
    }
    await dispatchPending(r.db, { limit: count });
  };

  const registerWorker = async (workerId: string): Promise<string> => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/fleet/workers/register",
      headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
      payload: { workerId, hostname: `host-${workerId}`, lane: "batch", capacity: 4 },
    });
    if (res.statusCode !== 200) {
      throw new Error(`register(${workerId}) answered ${String(res.statusCode)}`);
    }
    return res.json<{ workerToken: string }>().workerToken;
  };

  const claim = (workerId: string, token: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url: "/internal/fleet/claim",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerId, lane: "batch", freeSlots: 1 },
    });

  const dispatchedLeft = async (): Promise<number> => {
    const rows = await r.db.execute(
      sql`SELECT count(*)::int AS n FROM job_runs WHERE status = 'dispatched'`,
    );
    return Number(rows.rows[0]?.["n"] ?? -1);
  };

  /** The budget a worker may legitimately have spent over a window of `elapsedMs`. */
  const budgetOver = (elapsedMs: number): number =>
    CLAIM_RATE_LIMIT_BURST + Math.ceil((elapsedMs / 1000) * CLAIM_RATE_LIMIT_PER_SECOND);

  it("throttles a parallel storm without losing or duplicating a single job", async () => {
    const jobs = 5;
    await seedDispatchedJobs(jobs);
    const token = await registerWorker("w-storm");

    const startedMs = Date.now();
    const answers = await Promise.all(Array.from({ length: STORM }, () => claim("w-storm", token)));
    const elapsedMs = Date.now() - startedMs;

    const statuses = answers.map((a) => a.statusCode);
    const served = statuses.filter((s) => s === 200 || s === 204).length;
    const throttled = statuses.filter((s) => s === 429).length;
    expect(served + throttled, "every answer is 200, 204 or 429").toBe(STORM);
    expect(throttled, "a burst of 50 parallel claims must run the budget out").toBeGreaterThan(0);
    expect(served, "one burst plus its refill is the whole budget").toBeLessThanOrEqual(
      budgetOver(elapsedMs),
    );

    // Every 429 says how long to wait, and the payload names the code the worker branches on.
    for (const a of answers.filter((x) => x.statusCode === 429)) {
      expect(a.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(Number(a.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    }

    // The whole point: throttling refuses to LOOK at the queue. Nothing was claimed twice and
    // nothing was taken out of the queue by a request that answered 429.
    const claimedIds = answers
      .filter((a) => a.statusCode === 200)
      .map((a) => a.json<{ jobRunId: string }>().jobRunId);
    expect(claimedIds).toHaveLength(jobs);
    expect(new Set(claimedIds).size, "a job handed to two workers would run twice").toBe(jobs);
    expect(await dispatchedLeft()).toBe(0);
  });

  it("keeps one storming worker from spending another worker's budget", async () => {
    const jobs = 6;
    await seedDispatchedJobs(jobs);
    const tokenA = await registerWorker("w-a");
    const tokenB = await registerWorker("w-b");

    const startedMs = Date.now();
    const answers = await Promise.all(
      Array.from({ length: STORM * 2 }, (_, i) =>
        i % 2 === 0 ? claim("w-a", tokenA) : claim("w-b", tokenB),
      ),
    );
    const elapsedMs = Date.now() - startedMs;

    const fromA = answers.filter((_, i) => i % 2 === 0).map((a) => a.statusCode);
    const fromB = answers.filter((_, i) => i % 2 === 1).map((a) => a.statusCode);
    for (const [name, own] of [
      ["w-a", fromA],
      ["w-b", fromB],
    ] as const) {
      const served = own.filter((s) => s === 200 || s === 204).length;
      expect(own.filter((s) => s === 429).length, `${name} must be throttled too`).toBeGreaterThan(0);
      // A shared (fleet-wide) budget would show up here: with two storms running, each worker
      // would be served far LESS than its own burst.
      expect(served, `${name} keeps a budget of its own`).toBeGreaterThanOrEqual(
        CLAIM_RATE_LIMIT_BURST,
      );
      expect(served, `${name} keeps no more than a budget of its own`).toBeLessThanOrEqual(
        budgetOver(elapsedMs),
      );
    }

    const claimedIds = answers
      .filter((a) => a.statusCode === 200)
      .map((a) => a.json<{ jobRunId: string }>().jobRunId);
    expect(new Set(claimedIds).size).toBe(jobs);
    expect(await dispatchedLeft()).toBe(0);
  });
});
