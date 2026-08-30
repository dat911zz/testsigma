/**
 * Route contract for the PUBLIC run plane: trigger a run, read its aggregate, abort it, and
 * follow it live over server-sent events. Handlers live in
 * `apps/core/src/modules/orchestration/routes.ts`.
 *
 * The fleet-facing plane (`/internal/fleet`, ./internal.ts) is the other half of M3 and is
 * deliberately NOT in `ROUTES`: it is not part of the tenant API and never reaches
 * openapi.json. These four routes are — they are what a CI job and the UI actually call.
 *
 * Two shapes are worth reading twice:
 *
 *  - `triggerRun` has TWO success answers. 202 = a plan was frozen and the chains are queued.
 *    200 = the request was perfectly well formed and the product's answer is `compile_error`
 *    plus the diagnostics. A compile error is a VERDICT, not an HTTP failure: answering 400
 *    would invite a CI client to retry a deterministic outcome.
 *  - `streamRun` responds `text/event-stream`, which this generator cannot describe (it emits
 *    `application/json` for every response). The 200 schema below is therefore the shape of
 *    ONE `status` frame's `data:` payload — the same `runStatusSchema` `getRun` returns — and
 *    the summary says so, rather than the endpoint going undocumented.
 */
import { z } from "zod";
import { JOB_STATUSES, LANES, RUN_LIFECYCLE_STATUSES, RUN_VERDICTS_WITH_PENDING } from "../enums.js";
import { compileDiagnosticSchema } from "../schemas/index.js";
import { errorResponseSchema } from "./identity.js";
import { defineRoute, type RouteDescriptor } from "./types.js";

const uuid = z.string().uuid();
/** Lowercase SHA-256 hex — the compiler's phase 7 `contentHashOf`. */
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);

const runIdParam = z.object({ runId: uuid });

/**
 * `ready` runs what has been promoted, `latest` runs the working copy. `ready` is the default
 * because a scheduled CI run must not silently pick up an unreviewed edit.
 */
export const snapshotPinSchema = z.enum(["ready", "latest"]);

/** Mirrors the compiler's `ScreenshotPolicy`; declared here because contract must not import it. */
export const screenshotPolicySchema = z.enum(["all", "failure", "none"]);

/**
 * `POST /v1/runs` body. No `teamId`: the tenant is born from the credential and can never be
 * chosen by the caller (Global Constraint, enforced by the L3 suite).
 *
 * The 500-case ceiling is a guard rail, not a quota: quota is counted in runs per day by
 * governance. It exists so a typo'd loop cannot ask phase 0 to compile a snapshot the size of
 * the whole project inside one request.
 */
export const triggerRunBodySchema = z.object({
  projectId: uuid,
  caseIds: z.array(uuid).min(1).max(500),
  lane: z.enum(LANES).default("batch"),
  pin: snapshotPinSchema.default("ready"),
  screenshots: screenshotPolicySchema.optional(),
});

/** 202 — a plan was frozen and one job per chain is in the queue. */
export const runQueuedSchema = z.object({
  runId: uuid,
  status: z.literal("queued"),
  planContentHash: contentHash,
  chainTotal: z.number().int().nonnegative(),
});

/** 200 — the run exists and is already finished, because it never compiled. */
export const runCompileErrorSchema = z.object({
  runId: uuid,
  status: z.literal("finished"),
  verdict: z.literal("compile_error"),
  diagnostics: z.array(compileDiagnosticSchema),
});

/** One chain of a run, as the queue currently holds it. */
export const runChainSchema = z.object({
  jobRunId: uuid,
  chainKey: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  attempt: z.number().int().positive(),
  leaseEpoch: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

/**
 * The run aggregate as a reader sees it. `chainDone` is DERIVED from the queue rather than read
 * from `orc_runs.chain_done`: no writer maintains that column yet, and a read model that lies
 * by one is worse than one that costs an extra scan of a handful of rows.
 */
export const runStatusSchema = z.object({
  runId: uuid,
  projectId: uuid,
  lane: z.enum(LANES),
  status: z.enum(RUN_LIFECYCLE_STATUSES),
  verdict: z.enum(RUN_VERDICTS_WITH_PENDING),
  planContentHash: contentHash.nullable(),
  chainTotal: z.number().int().nonnegative(),
  chainDone: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  jobs: z.array(runChainSchema),
  diagnostics: z.array(compileDiagnosticSchema),
});

/** 200 of `POST /v1/runs/{runId}/abort`. `cancelledJobs` counts what was still in flight. */
export const runAbortedSchema = z.object({
  runId: uuid,
  verdict: z.literal("cancelled"),
  cancelledJobs: z.number().int().nonnegative(),
});

export type RunQueuedDto = z.infer<typeof runQueuedSchema>;
export type RunCompileErrorDto = z.infer<typeof runCompileErrorSchema>;
export type RunChainDto = z.infer<typeof runChainSchema>;
export type RunStatusDto = z.infer<typeof runStatusSchema>;
export type RunAbortedDto = z.infer<typeof runAbortedSchema>;

/**
 * The `event:` names of the SSE stream. A closed list, exported so the UI client and the
 * handler read the same one instead of both hard-coding strings.
 */
export const RUN_STREAM_EVENTS = ["status", "run_event", "done"] as const;
export type RunStreamEvent = (typeof RUN_STREAM_EVENTS)[number];

export const triggerRunDescriptor = defineRoute({
  operationId: "triggerRun",
  method: "post",
  path: "/v1/runs",
  summary: "Compile and queue a run (202), or answer the compile diagnostics (200)",
  auth: "required",
  permission: "run:trigger",
  body: triggerRunBodySchema,
  responses: {
    200: runCompileErrorSchema,
    202: runQueuedSchema,
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    429: errorResponseSchema,
  },
});

export const getRunDescriptor = defineRoute({
  operationId: "getRun",
  method: "get",
  path: "/v1/runs/{runId}",
  summary: "Read a run aggregate with the state of each of its chains",
  auth: "required",
  permission: "run:read",
  params: runIdParam,
  responses: { 200: runStatusSchema, 403: errorResponseSchema, 404: errorResponseSchema },
});

export const abortRunDescriptor = defineRoute({
  operationId: "abortRun",
  method: "post",
  path: "/v1/runs/{runId}/abort",
  summary: "Cancel every chain of a run that has not finished yet",
  auth: "required",
  permission: "run:abort",
  params: runIdParam,
  responses: { 200: runAbortedSchema, 403: errorResponseSchema, 404: errorResponseSchema },
});

export const streamRunDescriptor = defineRoute({
  operationId: "streamRun",
  method: "get",
  path: "/v1/runs/{runId}/stream",
  summary:
    "Follow a run over server-sent events (text/event-stream). Frames: `status` carrying the schema below, `run_event` carrying one worker event, and a terminal `done`. Resume with Last-Event-ID.",
  auth: "required",
  permission: "run:read",
  params: runIdParam,
  responses: { 200: runStatusSchema, 403: errorResponseSchema, 404: errorResponseSchema },
});

/**
 * Appended (never inserted mid-array) to ROUTES so the committed openapi.json path order
 * stays byte-stable under the drift gate.
 */
export const orchestrationRoutes: readonly RouteDescriptor[] = [
  triggerRunDescriptor,
  getRunDescriptor,
  abortRunDescriptor,
  streamRunDescriptor,
];
