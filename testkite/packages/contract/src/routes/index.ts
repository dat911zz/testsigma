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

export const ROUTES: readonly RouteDescriptor[] = [...identityRoutes, ...authoringRoutes];
