/**
 * Harness for the internal fleet plane: a migrated PGlite, one run compiled through the REAL
 * phase 0 (so `orc_run_plans` holds a genuine frozen plan with a real content hash), its jobs
 * dispatched, and a Fastify instance serving `/internal/fleet` — plus the three credentials a
 * worker can hold.
 *
 * Everything a worker touches goes over HTTP here, never through a service call: the subject of
 * these tests is the WIRE contract the fleet plan codes against, and a helper that reached past
 * the router would prove nothing about it.
 *
 * The instance is built ONCE for the file and reseeded per test — migrate() costs ~3.6s while
 * TRUNCATE costs ~2ms (same shape as every other suite in this repo). Nothing is cached inside
 * the app, so a reset DB is a fresh world for it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { ElementDto } from "@testkite/contract";
import { makeTestDb, type SeededTeam, type TestDb } from "./pglite.js";
import { buildInternalApp } from "../../src/http/internal/app.js";
import { startRun, type StartRunDeps } from "../../src/modules/orchestration/run-service.js";
import { dispatchPending } from "../../src/modules/orchestration/queue/job-queue.js";
import { reapDeadLeases } from "../../src/modules/orchestration/queue/reaper.js";
import type { KernelEnv } from "../../src/modules/kernel/index.js";

/** The host credential. Long-lived and shared per host in production; per-file here. */
const BOOTSTRAP_TOKEN = "tkb_test_bootstrap_secret_value";
/**
 * The worker every test starts with. A second one is registered by the tests that need it.
 *
 * The id is UNIQUE PER TEST because the app — and with it the per-worker claim budget behind
 * `429 RATE_LIMITED` — is built once for the whole file while the database is reset per test.
 * A shared id would carry one test's spent budget into the next, so a storm test would silently
 * throttle whatever ran after it.
 */
let workerSeq = 0;
const nextWorkerId = (): string => {
  workerSeq += 1;
  return `w-${String(workerSeq)}`;
};
/**
 * The clock the per-worker claim budget refills on — VIRTUAL, and standing still unless a test
 * moves it with `advanceClaimClock()`.
 *
 * Real time here would make every storm assertion a coin flip: the bucket refills 10 tokens a
 * second, and sixty sequential HTTP + database round trips take however long the host is in the
 * mood for — ~0.45s warm here, seconds under the monorepo's parallel test load. Measured on this
 * box: 22 of 60 calls served where the burst is 20, i.e. two tokens the storm did not pay for,
 * and whether the sixty-first call finds one more is decided by nothing the test controls. A
 * "flaky-by-design" test is exactly what let a real race hide in this repo for two milestones,
 * so the budget's clock is a port and the suite owns it.
 *
 * Nothing else on the plane reads it: leases, heartbeats and tokens all stamp the wall clock.
 */
let claimClockMs = 0;
/**
 * Jumped between tests, not during them. An hour refills every bucket to the brim, so a storm
 * cannot leak budget into whatever runs next — belt and braces with the per-test worker id.
 */
const CLAIM_CLOCK_STEP_MS = 3_600_000;

/** Three chains, so a test can claim two distinct jobs and still leave one in the queue. */
const CHAIN_COUNT = 3;
/** Four times the reaper's 30s dead threshold: nothing about this heartbeat is borderline. */
const DEAD_HEARTBEAT_SECONDS = 120;

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

/**
 * The elements module only lands in M4, so phase 0 takes both loaders as injection ports. Every
 * element answers "ready" here: a compile diagnostic would leave the queue empty, and the
 * subject of this harness is what happens AFTER a job exists.
 */
const COMPILE_DEPS: StartRunDeps = {
  loadElements: async (ids: readonly string[]): Promise<Record<string, ElementDto>> =>
    Object.fromEntries(
      ids.map((id): readonly [string, ElementDto] => [
        id,
        { id, name: `element ${id}`, status: "ready", locators: [{ kind: "css", value: `#${id}` }] },
      ]),
    ),
  loadDataProfiles: async () => ({}),
};

/** The response body of `POST /internal/fleet/claim`, as the worker receives it. */
export interface ClaimedJobBody {
  readonly jobRunId: string;
  readonly runId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseDeadlineAt: string;
  readonly runToken: string;
  readonly plan: unknown;
}

/** One row of `complete.steps[]`, flat and carrying its own caseId (the fleet contract's shape). */
export interface SampleStep {
  readonly caseId: string;
  readonly ordinal: number;
  readonly status: "passed" | "failed" | "skipped";
  readonly durationMs: number;
  readonly renderedSentence: string;
}

export interface InternalTestApp {
  /** The host credential — only `POST /workers/register` accepts it. */
  readonly bootstrapToken: string;
  readonly workerId: string;
  /** The worker credential of `workerId` — heartbeat and claim, nothing else. */
  readonly workerToken: string;
  readonly teamA: SeededTeam;
  readonly runId: string;
  post: (
    path: string,
    body: Readonly<Record<string, unknown>>,
    token: string,
  ) => Promise<LightMyRequestResponse>;
  get: (path: string, token: string) => Promise<LightMyRequestResponse>;
  /** Claims exactly one job over HTTP and fails loudly if the queue had nothing to give. */
  claimOneJob: () => Promise<ClaimedJobBody>;
  registerWorker: (workerId: string) => Promise<{ readonly workerId: string; readonly workerToken: string }>;
  setWorkerDrain: (drain: boolean) => Promise<void>;
  /** Ages the heartbeat past the dead threshold and runs the REAL reaper over it. */
  reapJob: (jobRunId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  /** Empties the claimable queue for every lane and every team — the 204 fixture. */
  drainQueue: () => Promise<void>;
  jobIdOfOtherTeam: () => Promise<string>;
  /** Jobs still sitting in the queue for a worker to take — the conservation check of a storm. */
  claimableJobCount: () => Promise<number>;
  /**
   * Moves the claim budget's clock forward by `ms`. The ONLY way time passes for the rate
   * limiter in this suite, which is what makes "the budget refilled by exactly N" assertable.
   */
  advanceClaimClock: (ms: number) => void;
  caseResultCount: (jobRunId: string) => Promise<number>;
  artifactStatuses: (jobRunId: string) => Promise<readonly string[]>;
  sampleStep: () => SampleStep;
  /**
   * Simulates `seconds` of elapsed time for the fleet plane by rewinding every deadline it has
   * stamped so far. Moving the rows back is the only way to age a lease here: the plane reads
   * `now()` from the DATABASE (that is the whole point of `heartbeat_at`), so there is no clock
   * to inject, and a test that actually slept would take minutes to say anything.
   *
   * Only the two tables that carry a DEADLINE are touched — the job lease and the run token.
   * The worker token's own 24h TTL is untouched on purpose: a test about the run credential
   * must not be able to pass by accidentally renewing the worker one.
   */
  rewindFleetClock: (seconds: number) => Promise<void>;
  /** `expires_at` of the live run token for a job — the value a heartbeat is supposed to move. */
  runTokenExpiry: (jobRunId: string) => Promise<Date>;
  /**
   * `pg_get_constraintdef` of a named constraint on the MIGRATED database. The only way to
   * assert what the column actually accepts: the schema file states an intent, the migrated
   * constraint is what a worker's row will really be judged against.
   */
  constraintDef: (name: string) => Promise<string>;
  /**
   * Runs a statement the schema is expected to REFUSE, returning the whole Postgres cause chain.
   * PGlite/drizzle bury the constraint name below `.cause` (see job-runs-schema.test.ts), so an
   * assertion on `.message` alone would pass for any failure whatsoever — including a typo.
   */
  rejectionOf: (text: string, params: readonly unknown[]) => Promise<string>;
  /** The team and run every seeded job belongs to — a valid FK target for a negative INSERT. */
  seedIds: () => { readonly teamId: string; readonly runId: string };
}

type Shared = { readonly t: TestDb; readonly app: FastifyInstance };

let shared: Shared | undefined;

async function build(): Promise<Shared> {
  const t = await makeTestDb();
  const app = await buildInternalApp({
    env: ENV,
    db: t.db,
    bootstrapTokenHash: createHash("sha256").update(BOOTSTRAP_TOKEN).digest(),
    claimClock: (): number => claimClockMs,
  });
  await app.ready();
  return { t, app };
}

/**
 * Builds the world for ONE test: a fresh tenant pair, a compiled run with `CHAIN_COUNT`
 * dispatched jobs, a pending job belonging to the OTHER team (never dispatched, so it can only
 * ever be reached by id — which is the point), and a registered worker.
 */
export async function makeInternalTestApp(): Promise<InternalTestApp> {
  shared ??= await build();
  const { t, app } = shared;
  // Between tests, never inside one: the plane — and with it the limiter's buckets — is built
  // once for the file, so this is what hands each test a full budget it can then spend exactly.
  claimClockMs += CLAIM_CLOCK_STEP_MS;
  await t.reset();
  const [teamA, teamB] = await t.seedTwoTeams();

  const caseIds = await t.seedRunnableCases(teamA, CHAIN_COUNT);
  const started = await t.asTeamCtx(teamA.teamId, (tx, ctx) =>
    startRun(
      tx,
      ctx,
      {
        projectId: teamA.projectId,
        targetCaseIds: caseIds,
        lane: "batch",
        pin: "latest",
        requestedBy: teamA.userId,
        now: new Date(),
      },
      COMPILE_DEPS,
    ),
  );
  if (started.kind !== "queued") {
    throw new Error(`internal harness: phase 0 did not queue the run (${started.kind})`);
  }
  await dispatchPending(t.db, { limit: CHAIN_COUNT });
  // Seeded AFTER the fan-out on purpose: it stays `pending`, so it is unclaimable and exists
  // only as an id belonging to somebody else.
  const foreignJobs = await t.seedJobs(teamB, 1);
  const foreignJobId = foreignJobs[0];
  if (foreignJobId === undefined) throw new Error("internal harness: seedJobs returned no job");

  const request = async (
    method: "POST" | "GET",
    path: string,
    token: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { payload: body }),
    });

  const registerWorker = async (
    workerId: string,
  ): Promise<{ readonly workerId: string; readonly workerToken: string }> => {
    const res = await request("POST", "/internal/fleet/workers/register", BOOTSTRAP_TOKEN, {
      workerId,
      hostname: `host-${workerId}`,
      lane: "batch",
      capacity: 4,
    });
    if (res.statusCode !== 200) {
      throw new Error(`internal harness: register(${workerId}) answered ${String(res.statusCode)}`);
    }
    const body: unknown = res.json();
    const token = (body as { workerToken?: unknown }).workerToken;
    if (typeof token !== "string") throw new Error("internal harness: register returned no token");
    return { workerId, workerToken: token };
  };

  const worker = await registerWorker(nextWorkerId());

  return {
    bootstrapToken: BOOTSTRAP_TOKEN,
    workerId: worker.workerId,
    workerToken: worker.workerToken,
    teamA,
    runId: started.runId,
    post: (path, body, token) => request("POST", path, token, body),
    get: (path, token) => request("GET", path, token),
    claimOneJob: async (): Promise<ClaimedJobBody> => {
      const res = await request("POST", "/internal/fleet/claim", worker.workerToken, {
        workerId: worker.workerId,
        lane: "batch",
        freeSlots: 1,
      });
      if (res.statusCode !== 200) {
        throw new Error(`internal harness: claim answered ${String(res.statusCode)}, wanted a job`);
      }
      return res.json<ClaimedJobBody>();
    },
    registerWorker,
    setWorkerDrain: (drain: boolean) => t.setWorkerDrain(worker.workerId, drain),
    reapJob: async (jobRunId: string): Promise<void> => {
      await t.ageHeartbeat(jobRunId, DEAD_HEARTBEAT_SECONDS);
      await reapDeadLeases(t.db);
    },
    cancelRun: async (runId: string): Promise<void> => {
      // Only `job_runs` matters to the fence — that is the row every mutation is classified
      // against — but the run aggregate is written too, so the fixture leaves a state an
      // operator could actually observe rather than an impossible one.
      await t.raw.query(
        `UPDATE job_runs SET status = 'cancelled', finished_at = now() WHERE run_id = $1`,
        [runId],
      );
      await t.raw.query(
        `UPDATE orc_runs SET status = 'finished', verdict = 'cancelled', finished_at = now() WHERE id = $1`,
        [runId],
      );
    },
    drainQueue: async (): Promise<void> => {
      await t.raw.query(
        `UPDATE job_runs SET status = 'cancelled' WHERE status IN ('pending', 'dispatched')`,
      );
    },
    jobIdOfOtherTeam: async (): Promise<string> => foreignJobId,
    claimableJobCount: async (): Promise<number> => {
      const r = await t.raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_runs WHERE status = 'dispatched'`,
      );
      return r.rows[0]?.n ?? 0;
    },
    advanceClaimClock: (ms: number): void => {
      claimClockMs += ms;
    },
    caseResultCount: async (jobRunId: string): Promise<number> => {
      const r = await t.raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM res_case_results WHERE job_run_id = $1`,
        [jobRunId],
      );
      return r.rows[0]?.n ?? 0;
    },
    artifactStatuses: async (jobRunId: string): Promise<readonly string[]> => {
      const r = await t.raw.query<{ status: string }>(
        `SELECT status FROM res_artifacts WHERE job_run_id = $1 ORDER BY created_at, id`,
        [jobRunId],
      );
      return r.rows.map((row) => row.status);
    },
    sampleStep: (): SampleStep => ({
      caseId: SAMPLE_CASE_ID,
      ordinal: 1,
      status: "passed",
      durationMs: 91,
      renderedSentence: "Click Login",
    }),
    rewindFleetClock: async (seconds: number): Promise<void> => {
      await t.raw.query(
        `UPDATE job_runs
            SET heartbeat_at = heartbeat_at - make_interval(secs => $1::double precision),
                lease_expires_at = lease_expires_at - make_interval(secs => $1::double precision),
                started_at = started_at - make_interval(secs => $1::double precision)
          WHERE status = 'running'`,
        [seconds],
      );
      await t.raw.query(
        `UPDATE orc_run_tokens
            SET expires_at = expires_at - make_interval(secs => $1::double precision)`,
        [seconds],
      );
    },
    runTokenExpiry: async (jobRunId: string): Promise<Date> => {
      const r = await t.raw.query<{ expires_at: string | Date }>(
        `SELECT expires_at FROM orc_run_tokens
          WHERE job_run_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [jobRunId],
      );
      const value = r.rows[0]?.expires_at;
      if (value === undefined) throw new Error(`runTokenExpiry: no live token for ${jobRunId}`);
      return value instanceof Date ? value : new Date(value);
    },
    constraintDef: async (name: string): Promise<string> => {
      const r = await t.raw.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [name],
      );
      const def = r.rows[0]?.def;
      if (def === undefined) throw new Error(`constraintDef: no constraint named ${name}`);
      return def;
    },
    rejectionOf: async (text: string, params: readonly unknown[]): Promise<string> => {
      try {
        await t.raw.query(text, [...params]);
      } catch (err: unknown) {
        const parts: string[] = [];
        let cur: unknown = err;
        while (cur instanceof Error) {
          parts.push(cur.message);
          cur = cur.cause;
        }
        return parts.join(" | ");
      }
      throw new Error("statement was expected to be rejected by Postgres, but it succeeded");
    },
    seedIds: () => ({ teamId: teamA.teamId, runId: started.runId }),
  };
}

/**
 * One case id for every `sampleStep()` of a file: `res_case_results` groups by it, so a random
 * id per call would turn "one step" into "one case per step" and make the count assertions
 * about the harness rather than about the endpoint.
 */
const SAMPLE_CASE_ID = randomUUID();

export async function closeInternalTestApp(): Promise<void> {
  if (shared === undefined) return;
  const { t, app } = shared;
  shared = undefined;
  await app.close();
  await t.close();
}
