/**
 * @testkite/contract — zod là NGUỒN hợp đồng duy nhất.
 * OpenAPI 3.1 được SINH RA từ đây và commit; CI fail khi drift; oasdiff chặn breaking change.
 */

// ---------------------------------------------------------------------------
// Verdicts (docs/SYSTEM_DESIGN.md §2, §4) — định nghĩa ở `./enums.js` (module lá),
// tái xuất ở đây để bề mặt facade không đổi. Schema import thẳng module lá, không
// qua barrel này: barrel re-export schemas nên đọc ngược lên đây là vòng import.
// ---------------------------------------------------------------------------

export * from "./enums.js";
export * from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Error taxonomy — MỘT vị từ (`retryable === true`) gate mọi retry ở mọi nơi.
// Định nghĩa ở `./errors.js` (module lá) để `routes/*.ts` ném được lỗi HTTP mà
// không đọc ngược lên barrel này (vòng import).
// ---------------------------------------------------------------------------

export * from "./errors.js";

// ---------------------------------------------------------------------------
// OpenAPI (zod là nguồn, openapi.json là đầu ra). Schema DTO đã tái xuất ở trên
// qua `./schemas/index.js` — không lặp lại ở đây (duplicate export).
// ---------------------------------------------------------------------------

export { buildOpenApiDocument, OPENAPI_INFO, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";
