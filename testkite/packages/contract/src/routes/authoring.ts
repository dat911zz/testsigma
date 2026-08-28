/**
 * Route contract for the authoring case lifecycle: create -> edit steps -> submit ->
 * review -> promote. Handlers live in apps/core/src/modules/authoring/routes/cases.ts.
 *
 * These descriptors are the single source read by three consumers (see ./types.ts):
 * OpenAPI paths, the Fastify router (via `config.tk`), and the L3 cross-tenant suite.
 * The request-body schemas are defined here (reusing the shared DTO schemas) and the
 * apps/core handlers import them back, so the wire shape cannot drift from the docs.
 *
 * Permission mapping note: there is no distinct `case:review` permission in the RBAC
 * matrix (identity owns that list); reviewing and promoting are the gatekeeper pair,
 * so both require `case:promote`. Four-eyes (reviewer/promoter must differ from the
 * last editor) provides the human separation of duties, not a second scope.
 */
import { z } from "zod";
import { reviewDecisionSchema, stepInputSchema } from "../schemas/index.js";
import { caseSummarySchema } from "../schemas/authoring.js";
import { errorResponseSchema } from "./identity.js";
import { defineRoute, type RouteDescriptor } from "./types.js";

const caseIdParam = z.object({ caseId: z.string().uuid() });

/** POST /v1/projects/{projectId}/cases body. `isStepGroup` defaults to false. */
export const createCaseBodySchema = z.object({
  name: z.string().min(1),
  isStepGroup: z.boolean().default(false),
  prereqCaseId: z.string().uuid().optional(),
});

/** PUT /v1/cases/{caseId}/steps body — the full ordered list of steps to persist. */
export const replaceStepsBodySchema = z.object({ steps: z.array(stepInputSchema) });

/** POST /v1/cases/{caseId}/review body — the reviewer's decision plus an optional note. */
export const reviewBodySchema = z.object({
  decision: reviewDecisionSchema,
  comment: z.string().min(1).optional(),
});

export const createCaseDescriptor = defineRoute({
  operationId: "createCase",
  method: "post",
  path: "/v1/projects/{projectId}/cases",
  summary: "Create a case inside a project",
  auth: "required",
  permission: "case:write",
  params: z.object({ projectId: z.string().uuid() }),
  body: createCaseBodySchema,
  responses: { 201: caseSummarySchema, 403: errorResponseSchema, 404: errorResponseSchema },
});

export const getCaseDescriptor = defineRoute({
  operationId: "getCase",
  method: "get",
  path: "/v1/cases/{caseId}",
  summary: "Fetch a case summary with its current version (ETag source)",
  auth: "required",
  permission: "case:read",
  params: caseIdParam,
  responses: { 200: caseSummarySchema, 403: errorResponseSchema, 404: errorResponseSchema },
});

export const replaceStepsDescriptor = defineRoute({
  operationId: "replaceSteps",
  method: "put",
  path: "/v1/cases/{caseId}/steps",
  summary: "Replace a case's steps (optimistic concurrency: requires If-Match)",
  auth: "required",
  permission: "case:write",
  params: caseIdParam,
  body: replaceStepsBodySchema,
  responses: {
    200: caseSummarySchema,
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    428: errorResponseSchema,
  },
});

export const submitReviewDescriptor = defineRoute({
  operationId: "submitReview",
  method: "post",
  path: "/v1/cases/{caseId}/submit-review",
  summary: "Submit a draft case for review (requires If-Match)",
  auth: "required",
  permission: "case:write",
  params: caseIdParam,
  responses: {
    200: caseSummarySchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    428: errorResponseSchema,
  },
});

export const withdrawReviewDescriptor = defineRoute({
  operationId: "withdrawReview",
  method: "post",
  path: "/v1/cases/{caseId}/withdraw-review",
  summary: "Withdraw a case from review back to draft (requires If-Match)",
  auth: "required",
  permission: "case:write",
  params: caseIdParam,
  responses: {
    200: caseSummarySchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    428: errorResponseSchema,
  },
});

export const reviewCaseDescriptor = defineRoute({
  operationId: "reviewCase",
  method: "post",
  path: "/v1/cases/{caseId}/review",
  summary: "Record a review decision: approve or request changes (requires If-Match)",
  auth: "required",
  permission: "case:promote",
  params: caseIdParam,
  body: reviewBodySchema,
  responses: {
    200: caseSummarySchema,
    400: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    428: errorResponseSchema,
  },
});

export const promoteCaseDescriptor = defineRoute({
  operationId: "promoteCase",
  method: "post",
  path: "/v1/cases/{caseId}/promote",
  summary: "Promote an approved case to ready (four-eyes; requires If-Match)",
  auth: "required",
  permission: "case:promote",
  params: caseIdParam,
  responses: {
    200: caseSummarySchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    428: errorResponseSchema,
  },
});

/**
 * Appended (never inserted mid-array) to ROUTES so the committed openapi.json path
 * order stays byte-stable under the drift gate.
 */
export const authoringRoutes: readonly RouteDescriptor[] = [
  createCaseDescriptor,
  getCaseDescriptor,
  replaceStepsDescriptor,
  submitReviewDescriptor,
  withdrawReviewDescriptor,
  reviewCaseDescriptor,
  promoteCaseDescriptor,
];
