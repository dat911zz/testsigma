/**
 * System-wide route registry.
 *
 * ORDER MATTERS: it is the `paths` key order in the committed openapi.json, which the
 * drift gate compares BYTE for byte. A new module appends to the END of the array,
 * never inserts in the middle.
 */
import { authoringRoutes } from "./authoring.js";
import { identityRoutes } from "./identity.js";
import type { RouteDescriptor } from "./types.js";

export * from "./types.js";
export { errorResponseSchema, identityRoutes } from "./identity.js";
export * from "./authoring.js";
// The fleet plane. Re-exported so `apps/runner` can import its schemas, but deliberately NOT
// merged into ROUTES: /internal/fleet is not part of the tenant API and must never reach
// openapi.json (gate in .github/workflows/testkite-ci.yml).
export * from "./internal.js";

export const ROUTES: readonly RouteDescriptor[] = [...identityRoutes, ...authoringRoutes];
