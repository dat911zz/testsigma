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
 * OpenAPI 3.1 cho phép thiếu `paths` (khác 3.0). M2 gắn route thật vào đây.
 */
import { createDocument } from "zod-openapi";
import type { oas31 } from "zod-openapi";
import {
  authoredCaseSchema,
  authoredStepSchema,
  compileDiagnosticSchema,
  dataProfileSchema,
  dataRowSchema,
  elementSchema,
  envSchema,
  locatorSchema,
  runSchema,
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
] as const;

export const OPENAPI_INFO = {
  title: "TestKite Contract",
  version: "0.0.1",
  description:
    "Catalog schema authoring-facing của TestKite, sinh từ zod. M1: chỉ components.schemas — paths gắn ở M2 cùng route Fastify.",
} as const;

export function buildOpenApiDocument(): oas31.OpenAPIObject {
  return createDocument({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    components: {
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
      },
    },
  });
}

/** Dạng byte CHÍNH THỨC của spec: 2 space indent, newline cuối file. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
