/**
 * @testkite/contract — zod is the SINGLE source of truth for the contract.
 * OpenAPI 3.1 is GENERATED from it and committed; CI fails on drift; oasdiff blocks breaking changes.
 */

// ---------------------------------------------------------------------------
// Verdicts (docs/SYSTEM_DESIGN.md §2, §4) — defined in `./enums.js` (leaf module),
// re-exported here so the facade surface stays the same. Schemas import the leaf module
// directly, not through this barrel: the barrel re-exports schemas, so reading back up to
// here would be an import cycle.
// ---------------------------------------------------------------------------

export * from "./enums.js";
export * from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Error taxonomy — ONE predicate (`retryable === true`) gates every retry everywhere.
// Defined in `./errors.js` (leaf module) so `routes/*.ts` can throw HTTP errors without
// reading back up to this barrel (import cycle).
// ---------------------------------------------------------------------------

export * from "./errors.js";

// ---------------------------------------------------------------------------
// OpenAPI (zod is the source, openapi.json is the output). DTO schemas are already
// re-exported above via `./schemas/index.js` — not repeated here (duplicate export).
// ---------------------------------------------------------------------------

export { buildOpenApiDocument, OPENAPI_INFO, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";

// ---------------------------------------------------------------------------
// Route registry (`ROUTES`) + `RouteDescriptor` type: ONE source for OpenAPI,
// the Fastify router, and the L3 cross-tenant test suite. `routes/*` only reads
// `./errors.js` (leaf module), so re-exporting here creates no cycle.
// ---------------------------------------------------------------------------

export * from "./routes/index.js";
