/**
 * The same gate idea as test/isolation/coverage.test.ts: a NEW /internal/fleet endpoint that
 * nobody wrote a contract test for would ship unguarded. This turns that silence red.
 *
 * The first suite is a static check on the descriptor list — no app, no DB, milliseconds.
 *
 * The second suite is the same job for the CLOSED SETS the fleet plane speaks in, and it
 * deliberately costs a database: `packages/contract` cannot import `apps/core`, so every closed
 * set exists twice — once as a zod enum on the wire, once as a CHECK constraint on the column —
 * and only one of those two is the schema file. What a migrated column really accepts can be
 * read from the database and nowhere else, and the value of an agreement between two copies is
 * exactly zero until something reads both. Event kinds and artifact kinds already had their
 * anchor above; `lane` and the artifact size ceiling did not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ARTIFACT_MAX_SIZE_BYTES,
  CLAIM_RATE_LIMIT_BURST,
  CLAIM_RATE_LIMIT_PER_SECOND,
  INTERNAL_ROUTES,
  registerRequestSchema,
  ROUTES,
  RUN_EVENT_KIND_VALUES,
} from "@testkite/contract";
import { ARTIFACT_KINDS, ARTIFACT_MAX_BYTES } from "../../src/modules/results/index.js";
import { RUN_EVENT_KINDS } from "../../src/modules/orchestration/events.js";
import {
  closeInternalTestApp,
  makeInternalTestApp,
  type InternalTestApp,
} from "../harness/internal.js";

/** Endpoints that mutate a job and therefore MUST carry leaseEpoch. */
const EPOCH_REQUIRED = [
  "internalJobHeartbeat",
  "internalEvents",
  "internalArtifacts",
  "internalComplete",
];
/**
 * Routes that publish `429 RATE_LIMITED`. It is exactly the set the server actually throttles:
 * a descriptor promising a 429 nobody can trigger teaches the fleet plan to write dead code,
 * and a throttled route with no 429 in its descriptor teaches it to treat one as a crash.
 */
const RATE_LIMITED = ["internalClaim"];
const EPOCH_EXEMPT: Record<string, string> = {
  internalRegister: "registration happens before any job exists, so there is no lease to fence",
  internalWorkerHeartbeat:
    "a worker-level heartbeat is about the host, not about any one job's lease",
  internalClaim: "the claim is what CREATES the epoch; requiring one would be circular",
};

describe("/internal/fleet route coverage", () => {
  it("every mutating route requires leaseEpoch in its body schema", () => {
    for (const op of EPOCH_REQUIRED) {
      const r = INTERNAL_ROUTES.find((x) => x.operationId === op);
      expect(r, `${op} is missing from INTERNAL_ROUTES`).toBeDefined();
      expect(
        Object.keys(r?.body?.shape ?? {}),
        `${op} body must carry leaseEpoch`,
      ).toContain("leaseEpoch");
    }
  });

  it("every route is either epoch-required or exempt with a written reason", () => {
    for (const r of INTERNAL_ROUTES) {
      const covered =
        EPOCH_REQUIRED.includes(r.operationId) || EPOCH_EXEMPT[r.operationId] !== undefined;
      expect(
        covered,
        `${r.operationId}: add it to EPOCH_REQUIRED or justify it in EPOCH_EXEMPT`,
      ).toBe(true);
    }
    for (const [op, reason] of Object.entries(EPOCH_EXEMPT)) {
      expect(reason.length, `${op}: reason is too short`).toBeGreaterThan(30);
    }
  });

  it("declares a credential kind on every route", () => {
    for (const r of INTERNAL_ROUTES) expect(["bootstrap", "worker", "run"]).toContain(r.credential);
  });

  it("keeps every path under /internal/fleet and out of the public ROUTES array", () => {
    for (const r of INTERNAL_ROUTES) expect(r.path.startsWith("/internal/fleet/")).toBe(true);
    expect(ROUTES.some((r) => r.path.startsWith("/internal"))).toBe(false);
  });

  it("publishes all seven endpoints of the fleet contract, and no eighth", () => {
    expect(INTERNAL_ROUTES.map((r) => r.operationId)).toEqual([
      "internalRegister",
      "internalWorkerHeartbeat",
      "internalClaim",
      "internalJobHeartbeat",
      "internalEvents",
      "internalArtifacts",
      "internalComplete",
    ]);
  });

  it("keeps the event-kind list identical on both sides of the module boundary", () => {
    // contract cannot import apps/core, so the list exists twice; this is the only thing
    // stopping the two copies from drifting.
    expect([...RUN_EVENT_KIND_VALUES]).toEqual([...RUN_EVENT_KINDS]);
  });

  it("publishes 429 RATE_LIMITED on exactly the routes that are throttled", () => {
    for (const r of INTERNAL_ROUTES) {
      expect(
        r.responses[429] !== undefined,
        `${r.operationId}: a 429 in the descriptor and a rate limiter in the handler are one decision`,
      ).toBe(RATE_LIMITED.includes(r.operationId));
    }
  });

  it("gives a worker enough burst to fill every slot it is allowed to own", () => {
    // A worker registers with a capacity, then claims ONE job per request until its slots are
    // full. If the burst were smaller than the largest capacity the contract accepts, a healthy
    // cold start would answer 429 — the limiter would be throttling correct behaviour.
    const capacity: unknown = registerRequestSchema.shape.capacity.maxValue;
    expect(typeof capacity).toBe("number");
    expect(CLAIM_RATE_LIMIT_BURST).toBeGreaterThanOrEqual(capacity as number);
    expect(CLAIM_RATE_LIMIT_PER_SECOND).toBeGreaterThan(0);
  });

  it("keeps the artifact-kind list identical on both sides of the module boundary", () => {
    // Same duplication, same reason: `res_artifacts` builds its CHECK from ARTIFACT_KINDS,
    // while the wire schema has to state the five values without importing apps/core. A kind
    // the edge accepts but the column refuses would be a 500 on a worker's upload request.
    const wire = INTERNAL_ROUTES.find((r) => r.operationId === "internalArtifacts");
    const kind: unknown = wire?.body?.shape?.["kind"];
    expect(kind).toBeDefined();
    expect((kind as { options: readonly string[] }).options).toEqual([...ARTIFACT_KINDS]);
  });

  it("keeps the artifact size ceiling identical on both sides of the module boundary", () => {
    // `2_147_483_647` is written out twice — `results/db/artifact-schema.ts` builds the column's
    // CHECK from one copy, `routes/internal.ts` states the other on the wire. Lower the wire's
    // copy alone and workers get a 400 for uploads the column would have taken; raise it alone
    // and the edge accepts a size the column then refuses, i.e. a 500 on an upload that did
    // nothing wrong. Neither is visible in a diff that touches one file.
    expect(ARTIFACT_MAX_SIZE_BYTES).toBe(ARTIFACT_MAX_BYTES);
  });
});

/** The lane values `POST /workers/register` really accepts, read off the wire schema. */
const wireLanes = (): readonly string[] => registerRequestSchema.shape.lane.options;

/**
 * Pulls the quoted values out of a `CHECK ((lane)::text = ANY (ARRAY['interactive'::text, …]))`
 * — the shape Postgres normalises `lane IN ('interactive','batch')` into. Deliberately reads
 * whatever the constraint says rather than asserting one exact rendering: the subject is the
 * SET of accepted values, and the rendering is the database's business.
 */
const literalsOf = (constraintDef: string): readonly string[] =>
  [...constraintDef.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");

describe("/internal/fleet lane — one closed set, three independent declarations", () => {
  let h: InternalTestApp;
  beforeAll(async () => {
    h = await makeInternalTestApp();
  });
  afterAll(async () => {
    await closeInternalTestApp();
  });

  it("keeps the lane list identical on the wire and in BOTH lane CHECK constraints", async () => {
    // Three declarations of two values: the contract's `z.enum(LANES)`, `job_runs_lane_check`,
    // and `orc_workers_lane_check`. A lane the edge accepts but a column refuses is a 500 on a
    // correct request; a lane a column accepts but the edge refuses is a worker that cannot
    // register at all.
    const wire = [...wireLanes()].sort();
    for (const name of ["job_runs_lane_check", "orc_workers_lane_check"]) {
      const def = await h.constraintDef(name);
      expect([...literalsOf(def)].sort(), `${name} drifted from the wire schema: ${def}`).toEqual(
        wire,
      );
    }
  });

  it("refuses a lane outside the set on job_runs — the column, not just the edge", async () => {
    const { teamId, runId } = h.seedIds();
    const msg = await h.rejectionOf(
      `INSERT INTO job_runs (team_id, run_id, chain_key, lane, queue_seq)
         VALUES ($1, $2, 'lane-probe', 'turbo', nextval('job_runs_queue_seq'))`,
      [teamId, runId],
    );
    expect(msg).toMatch(/job_runs_lane_check/);
  });

  it("refuses a lane outside the set on orc_workers — the roster is the same closed set", async () => {
    const msg = await h.rejectionOf(
      `INSERT INTO orc_workers (id, hostname, lane, capacity, prefix, token_hash, token_expires_at)
         VALUES ('lane-probe', 'host-probe', 'turbo', 1, 'tkw_', decode('00', 'hex'), now() + interval '1 day')`,
      [],
    );
    expect(msg).toMatch(/orc_workers_lane_check/);
  });

  it("answers 400 to a register carrying a lane the contract does not know", async () => {
    const res = await h.post(
      "/internal/fleet/workers/register",
      { workerId: "w-lane-probe", hostname: "host-probe", lane: "turbo", capacity: 1 },
      h.bootstrapToken,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
