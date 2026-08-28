/**
 * Route contract — ONE source for three consumers:
 *   1. `packages/contract/src/openapi.ts`   -> generates `paths`
 *   2. `apps/core/src/http/app.ts`          -> registers the Fastify router
 *   3. `apps/core/test/isolation/*`         -> generates the L3 cross-tenant test suite
 * Add a route and forget one of the three? Can't happen: all three read this same array.
 */
import type { z } from "zod";

export type HttpMethod = "get" | "post" | "patch" | "put" | "delete";

export type RouteDescriptor = {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI form: `/v1/cases/{caseId}`. Fastify recognizes `:caseId` via toFastifyPath(). */
  readonly path: string;
  readonly summary: string;
  readonly auth: "required" | "public";
  /** Required permission (name validated in identity/rbac). `null` = login only required. */
  readonly permission: string | null;
  readonly params?: z.AnyZodObject;
  readonly query?: z.AnyZodObject;
  readonly body?: z.ZodTypeAny;
  readonly responses: Readonly<Record<number, z.ZodTypeAny>>;
};

/** Only exists so TypeScript keeps the literal type — no transformation. */
export function defineRoute<T extends RouteDescriptor>(r: T): T {
  return r;
}

export function toFastifyPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
}
