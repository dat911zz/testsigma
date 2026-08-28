/**
 * OpenAPI 3.1 GENERATED from zod — zod is the source, this file is just the pipe.
 *
 * Library: `zod-openapi` pinned to exact 4.2.4. The latest release (6.x) requires
 * peer zod ^4; 4.2.4 is the last one that fully covers the workspace's `zod: ^3.24.1`
 * range. Chosen over `@asteasolutions/zod-to-openapi` because it does NOT need
 * `extendZodWithOpenApi(z)` — it doesn't patch the shared `zod` module's prototype,
 * so loading `@testkite/contract` doesn't change `@testkite/run-compiler`'s zod
 * behavior (that package must stay PURE).
 *
 * M1 only publishes the CATALOG SCHEMA (`components.schemas`), no `paths` yet:
 * no Fastify route exists yet, so generating paths now would be fabricating
 * documentation. OpenAPI 3.1 allows omitting `paths` (unlike 3.0). M2 wires real
 * routes in here: `paths` is generated FROM `ROUTES` — the same array the Fastify
 * router and the L3 cross-tenant test suite read, so the docs can't drift from
 * what actually runs.
 */
import { createDocument } from "zod-openapi";
import type {
  oas31,
  ZodOpenApiOperationObject,
  ZodOpenApiParameters,
  ZodOpenApiPathItemObject,
  ZodOpenApiPathsObject,
  ZodOpenApiResponseObject,
  ZodOpenApiResponsesObject,
} from "zod-openapi";
import { ROUTES, type RouteDescriptor } from "./routes/index.js";
import {
  authoredCaseSchema,
  authoredStepSchema,
  caseChangeSchema,
  caseSummarySchema,
  compileDiagnosticSchema,
  dataProfileSchema,
  dataRowSchema,
  elementSchema,
  envSchema,
  locatorSchema,
  runSchema,
  stepInputSchema,
  threeWayDiffSchema,
} from "./schemas/index.js";

/**
 * Order MUST NOT be shuffled: it's the key order in the committed openapi.json,
 * which the drift gate compares byte-for-byte. Add a new schema at the END.
 */
export const OPENAPI_SCHEMA_NAMES = [
  "Locator",
  "Element",
  "AuthoredStep",
  "AuthoredCase",
  "DataRow",
  "DataProfile",
  "Env",
  "CompileDiagnostic",
  "Run",
  "StepInput",
  "CaseSummary",
  "CaseChange",
  "ThreeWayDiff",
] as const;

export const OPENAPI_INFO = {
  title: "TestKite Contract",
  version: "0.0.1",
  description:
    "TestKite's authoring-facing catalog schema, generated from zod. M1: only components.schemas — paths get wired in M2 together with the Fastify routes.",
} as const;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Invalid data",
  401: "Not authenticated",
  403: "Missing permission within your own team",
  404: "Not found — INCLUDING a resource belonging to another team (never 403)",
  409: "Version conflict",
  428: "Missing If-Match",
  429: "Quota exceeded",
};

/** A valid OpenAPI `responses` key: a status code starting with 1..5. */
type StatusKey = `${1 | 2 | 3 | 4 | 5}${string}`;

function responsesOf(r: RouteDescriptor): ZodOpenApiResponsesObject {
  const responses: ZodOpenApiResponsesObject = {};
  for (const [status, schema] of Object.entries(r.responses)) {
    const response: ZodOpenApiResponseObject = {
      description: STATUS_TEXT[status] ?? status,
      content: { "application/json": { schema } },
    };
    // `Object.entries` widens the key type to `string`; the source is the descriptor's
    // `Record<number,…>` so every key is really a status code.
    responses[status as StatusKey] = response;
  }
  return responses;
}

function operationOf(r: RouteDescriptor): ZodOpenApiOperationObject {
  const requestParams: ZodOpenApiParameters = {};
  if (r.params !== undefined) requestParams["path"] = r.params;
  if (r.query !== undefined) requestParams["query"] = r.query;

  return {
    operationId: r.operationId,
    summary: r.summary,
    ...(Object.keys(requestParams).length > 0 ? { requestParams } : {}),
    ...(r.body !== undefined ? { requestBody: { content: { "application/json": { schema: r.body } } } } : {}),
    ...(r.auth === "required" ? { security: [{ bearerAuth: [] }] } : {}),
    responses: responsesOf(r),
  };
}

function buildPaths(): ZodOpenApiPathsObject {
  const paths: Record<string, ZodOpenApiPathItemObject> = {};
  for (const r of ROUTES) {
    const item: ZodOpenApiPathItemObject = paths[r.path] ?? {};
    item[r.method] = operationOf(r);
    paths[r.path] = item;
  }
  return paths;
}

export function buildOpenApiDocument(): oas31.OpenAPIObject {
  return createDocument({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "TestKite API token: `Authorization: Bearer tk_<prefix>_<secret>`. A token is bound to EXACTLY ONE team and always has an expiry.",
        },
      },
      schemas: {
        Locator: locatorSchema,
        Element: elementSchema,
        AuthoredStep: authoredStepSchema,
        AuthoredCase: authoredCaseSchema,
        DataRow: dataRowSchema,
        DataProfile: dataProfileSchema,
        Env: envSchema,
        CompileDiagnostic: compileDiagnosticSchema,
        Run: runSchema,
        StepInput: stepInputSchema,
        CaseSummary: caseSummarySchema,
        CaseChange: caseChangeSchema,
        ThreeWayDiff: threeWayDiffSchema,
      },
    },
  });
}

/** The CANONICAL byte form of the spec: 2-space indent, trailing newline. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
