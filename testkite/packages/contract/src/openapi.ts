/**
 * OpenAPI 3.1 SINH RA từ zod — zod là nguồn, file này chỉ là ống dẫn.
 *
 * Thư viện: `zod-openapi` pin exact 4.2.4. Bản mới nhất (6.x) đòi peer zod ^4;
 * 4.2.4 là bản cuối phủ trọn dải `zod: ^3.24.1` của workspace. Chọn nó thay
 * `@asteasolutions/zod-to-openapi` vì nó KHÔNG cần `extendZodWithOpenApi(z)` —
 * không vá prototype module `zod` dùng chung, nên nạp `@testkite/contract`
 * không đổi hành vi zod của `@testkite/run-compiler` (package phải PURE).
 *
 * M1 chỉ công bố CATALOG SCHEMA (`components.schemas`), chưa có `paths`:
 * chưa có route Fastify nào tồn tại, sinh path bây giờ là bịa tài liệu.
 * OpenAPI 3.1 cho phép thiếu `paths` (khác 3.0). M2 gắn route thật vào đây:
 * `paths` sinh TỪ `ROUTES` — cùng mảng mà router Fastify và bộ test cross-tenant
 * L3 đọc, nên tài liệu không thể lệch khỏi thứ chạy thật.
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
 * Thứ tự KHÔNG được đảo lung tung: nó là thứ tự key trong openapi.json commit,
 * mà gate drift so byte. Thêm schema mới thì THÊM VÀO CUỐI.
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
    "Catalog schema authoring-facing của TestKite, sinh từ zod. M1: chỉ components.schemas — paths gắn ở M2 cùng route Fastify.",
} as const;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Dữ liệu không hợp lệ",
  401: "Chưa xác thực",
  403: "Thiếu quyền trong chính team của mình",
  404: "Không tìm thấy — GỒM CẢ tài nguyên của team khác (không bao giờ 403)",
  409: "Xung đột phiên bản",
  428: "Thiếu If-Match",
  429: "Chạm quota",
};

/** Key hợp lệ của `responses` theo OpenAPI: mã trạng thái bắt đầu bằng 1..5. */
type StatusKey = `${1 | 2 | 3 | 4 | 5}${string}`;

function responsesOf(r: RouteDescriptor): ZodOpenApiResponsesObject {
  const responses: ZodOpenApiResponsesObject = {};
  for (const [status, schema] of Object.entries(r.responses)) {
    const response: ZodOpenApiResponseObject = {
      description: STATUS_TEXT[status] ?? status,
      content: { "application/json": { schema } },
    };
    // `Object.entries` làm rụng kiểu key về `string`; nguồn là `Record<number,…>`
    // của descriptor nên mọi key đều là mã trạng thái thật.
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
            "API token của TestKite: `Authorization: Bearer tk_<prefix>_<secret>`. Token gắn ĐÚNG MỘT team và luôn có hạn.",
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

/** Dạng byte CHÍNH THỨC của spec: 2 space indent, newline cuối file. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
