/**
 * The internal fleet plane. Same descriptor shape as the public routes (so the router, the
 * auth hook and the coverage gate all read one source), but deliberately NOT part of ROUTES:
 *   - openapi.json describes the TENANT API; /internal/fleet is an implementation detail
 *     between the control plane and its own workers, and publishing it invites people to call it;
 *   - the L3 isolation harness drives team credentials, which this plane does not accept at
 *     all — its cross-tenant guarantee is proven by internal-contract.test.ts instead.
 *
 * This file is the CONTRACT the fleet plan codes against: `apps/runner` imports these schemas
 * rather than re-declaring the payloads, so a field renamed here breaks the worker's build
 * instead of its production run.
 */
import { z } from "zod";
import { errorResponseSchema } from "./identity.js";
import { defineRoute, type RouteDescriptor } from "./types.js";

/**
 * Three credentials, none of which substitutes for another: the host's bootstrap token
 * registers a worker, the worker token claims work, and a run token — minted at claim time and
 * dead when the lease is — is the only thing that may write about one job.
 */
export type InternalCredential = "bootstrap" | "worker" | "run";
export type InternalRouteDescriptor = RouteDescriptor & { readonly credential: InternalCredential };

const jobParams = z.object({ jobRunId: z.string().uuid() });
const workerParams = z.object({ workerId: z.string().min(1).max(128) });
/** Every job mutation carries it. NOT optional — a missing leaseEpoch is a 400, never a default. */
const leaseEpoch = z.number().int().nonnegative();
const lane = z.enum(["interactive", "batch"]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const registerRequestSchema = z.object({
  workerId: z.string().min(1).max(128),
  hostname: z.string().min(1).max(255),
  lane,
  capacity: z.number().int().min(1).max(16),
});
export const registerResponseSchema = z.object({
  workerId: z.string(),
  lane,
  workerToken: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  drain: z.boolean(),
});

export const workerHeartbeatRequestSchema = z.object({
  freeSlots: z.number().int().nonnegative(),
  psi: z.object({ some10: z.number(), full10: z.number() }).optional(),
  rssBytes: z.number().int().nonnegative().optional(),
});
export const workerHeartbeatResponseSchema = z.object({
  command: z.enum(["continue", "drain"]),
  /** Null when the roster row was gone, i.e. nothing was renewed — see `touchWorker`. */
  workerTokenRenewedAt: z.string().nullable(),
});

export const claimRequestSchema = z.object({
  workerId: z.string().min(1).max(128),
  lane,
  freeSlots: z.number().int().min(1).max(16),
});
export const claimedJobSchema = z.object({
  jobRunId: z.string().uuid(),
  runId: z.string().uuid(),
  teamId: z.string().uuid(),
  projectId: z.string().uuid(),
  chainKey: z.string(),
  attempt: z.number().int().positive(),
  leaseEpoch: z.number().int().positive(),
  leaseDeadlineAt: z.string(),
  runToken: z.string(),
  /** The frozen RunPlan, verbatim. `unknown` here on purpose: contract must not import run-compiler. */
  plan: z.unknown(),
});

export const jobHeartbeatRequestSchema = z.object({ leaseEpoch });
export const jobHeartbeatResponseSchema = z.object({
  leaseDeadlineAt: z.string(),
  command: z.enum(["continue", "drain", "cancel"]),
});

/**
 * The closed set of things a worker may say. It exists a second time in apps/core (next to the
 * CHECK constraint the column carries) because the contract package must not import the app;
 * `internal-coverage.test.ts` asserts the two arrays are equal, which is the only thing keeping
 * them from drifting.
 */
export const RUN_EVENT_KIND_VALUES = [
  "chain_started",
  "case_started",
  "case_finished",
  "step_started",
  "step_finished",
  "screenshot",
  "infra_error",
] as const;
export const eventRequestSchema = z.object({
  leaseEpoch,
  seq: z.number().int().min(1),
  kind: z.enum(RUN_EVENT_KIND_VALUES),
  payload: z.record(z.unknown()).default({}),
});
export const eventResponseSchema = z.object({ accepted: z.boolean(), duplicate: z.boolean() });

/** Same duplication, same reason, as the event kinds: `res_artifacts` builds its CHECK from it. */
export const ARTIFACT_KIND_VALUES = [
  "trace",
  "screenshot",
  "screenshot_bundle",
  "video",
  "log",
] as const;
/**
 * 2GiB-1, the ceiling `res_artifacts` enforces as a CHECK. Stated at the edge too so the server
 * refuses to SIGN an oversized upload rather than discovering the problem after the bytes have
 * already been written.
 */
export const ARTIFACT_MAX_SIZE_BYTES = 2_147_483_647;
export const artifactRequestSchema = z.object({
  leaseEpoch,
  kind: z.enum(ARTIFACT_KIND_VALUES),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(ARTIFACT_MAX_SIZE_BYTES),
  sha256,
});
export const artifactResponseSchema = z.object({
  artifactId: z.string().uuid(),
  method: z.literal("PUT"),
  url: z.string(),
  headers: z.record(z.string()),
  expiresAt: z.string(),
});

/**
 * One step row per executed step, FLAT (carrying caseId) rather than nested per case — this is
 * the shape the fleet plan's worker already produces; the server groups by caseId when writing
 * res_case_results. The four presentation fields default so a worker that does not collect
 * screenshots still passes validation.
 */
export const completedStepSchema = z.object({
  caseId: z.string().uuid(),
  ordinal: z.number().int().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().int().nonnegative(),
  renderedSentence: z.string().default(""),
  failureContext: z.record(z.unknown()).nullable().default(null),
  screenshotArtifactId: z.string().uuid().nullable().default(null),
  thumbhash: z.string().nullable().default(null),
});
export const completedArtifactSchema = z.object({
  kind: z.enum(ARTIFACT_KIND_VALUES),
  sha256,
  sizeBytes: z.number().int().nonnegative(),
});
export const infraErrorSchema = z.object({
  code: z.enum(["browser_oom", "context_crash", "host_death", "lease_expired", "network"]),
  retryable: z.boolean(),
  message: z.string().max(2048),
  peakRssBytes: z.number().int().nonnegative().optional(),
});
/**
 * Exactly one of `verdict` / `infraError` is the real contract, and it is enforced by the
 * handler (400 VALIDATION_FAILED), not by a `.refine()` here.
 *
 * DELIBERATE DEVIATION from the plan's block, which wrapped this object in `.refine(...)`: that
 * returns a `ZodEffects`, which has NO `.shape`. Two things read the shape — the coverage gate
 * that proves every mutating endpoint declares `leaseEpoch`, and `apps/runner`, which builds
 * its request from these fields — so hiding the object behind an effect would have turned the
 * gate green by making it blind, which is the one failure mode a gate must not have.
 */
export const completeRequestSchema = z.object({
  leaseEpoch,
  verdict: z.enum(["passed", "failed", "aborted_early", "cancelled"]).optional(),
  infraError: infraErrorSchema.nullable().default(null),
  steps: z.array(completedStepSchema).default([]),
  artifacts: z.array(completedArtifactSchema).default([]),
});
export const completeResponseSchema = z.object({
  ok: z.literal(true),
  requeued: z.boolean(),
  attempt: z.number().int().positive(),
});

/** The five answers every job endpoint can give besides its own. 410 is two codes, one status. */
const jobErrors = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  410: errorResponseSchema,
};

/**
 * ORDER IS THE CONTRACT'S ORDER: register -> worker heartbeat -> claim -> the four job
 * endpoints. `internal-coverage.test.ts` pins it, so a route inserted in the middle (or an
 * eighth one appended silently) has to be an explicit decision.
 *
 * `permission: null` on every route is not an oversight: permissions are TEAM scopes granted to
 * a member, and none of these three credentials is a team credential. `credential` is what
 * gates them, and the coverage gate refuses a route that omits it.
 */
export const INTERNAL_ROUTES: readonly InternalRouteDescriptor[] = [
  {
    ...defineRoute({
      operationId: "internalRegister",
      method: "post",
      path: "/internal/fleet/workers/register",
      summary: "Register a worker with the fleet",
      auth: "required",
      permission: null,
      body: registerRequestSchema,
      responses: { 200: registerResponseSchema, 401: errorResponseSchema },
    }),
    credential: "bootstrap",
  },
  {
    ...defineRoute({
      operationId: "internalWorkerHeartbeat",
      method: "post",
      path: "/internal/fleet/workers/{workerId}/heartbeat",
      summary: "Worker liveness + PSI, returns a command",
      auth: "required",
      permission: null,
      params: workerParams,
      body: workerHeartbeatRequestSchema,
      responses: { 200: workerHeartbeatResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
    }),
    credential: "worker",
  },
  {
    ...defineRoute({
      operationId: "internalClaim",
      method: "post",
      path: "/internal/fleet/claim",
      summary: "Claim one job for a lane",
      auth: "required",
      permission: null,
      body: claimRequestSchema,
      // 204 carries no body at all: an empty queue is the normal answer, not an error.
      responses: { 200: claimedJobSchema, 204: z.undefined(), 401: errorResponseSchema },
    }),
    credential: "worker",
  },
  {
    ...defineRoute({
      operationId: "internalJobHeartbeat",
      method: "post",
      path: "/internal/fleet/jobs/{jobRunId}/heartbeat",
      summary: "Renew the lease on a running job",
      auth: "required",
      permission: null,
      params: jobParams,
      body: jobHeartbeatRequestSchema,
      responses: { 200: jobHeartbeatResponseSchema, ...jobErrors },
    }),
    credential: "run",
  },
  {
    ...defineRoute({
      operationId: "internalEvents",
      method: "post",
      path: "/internal/fleet/jobs/{jobRunId}/events",
      summary: "Report one run event (idempotent by seq)",
      auth: "required",
      permission: null,
      params: jobParams,
      body: eventRequestSchema,
      responses: { 202: eventResponseSchema, ...jobErrors },
    }),
    credential: "run",
  },
  {
    ...defineRoute({
      operationId: "internalArtifacts",
      method: "post",
      path: "/internal/fleet/jobs/{jobRunId}/artifacts",
      summary: "Get a presigned PUT URL for an artifact",
      auth: "required",
      permission: null,
      params: jobParams,
      body: artifactRequestSchema,
      responses: { 200: artifactResponseSchema, ...jobErrors },
    }),
    credential: "run",
  },
  {
    ...defineRoute({
      operationId: "internalComplete",
      method: "post",
      path: "/internal/fleet/jobs/{jobRunId}/complete",
      summary: "Finish a job with a verdict or an infra error",
      auth: "required",
      permission: null,
      params: jobParams,
      body: completeRequestSchema,
      responses: { 200: completeResponseSchema, ...jobErrors },
    }),
    credential: "run",
  },
];
