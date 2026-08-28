/**
 * Hợp đồng route — MỘT nguồn cho ba nơi tiêu thụ:
 *   1. `packages/contract/src/openapi.ts`   -> sinh `paths`
 *   2. `apps/core/src/http/app.ts`          -> đăng ký router Fastify
 *   3. `apps/core/test/isolation/*`         -> sinh bộ test cross-tenant L3
 * Thêm route mà quên một trong ba? Không xảy ra: cả ba đọc chính mảng này.
 */
import type { z } from "zod";

export type HttpMethod = "get" | "post" | "patch" | "put" | "delete";

export type RouteDescriptor = {
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Dạng OpenAPI: `/v1/cases/{caseId}`. Fastify nhận dạng `:caseId` qua toFastifyPath(). */
  readonly path: string;
  readonly summary: string;
  readonly auth: "required" | "public";
  /** Permission cần có (kiểm tên hợp lệ ở identity/rbac). `null` = chỉ cần đăng nhập. */
  readonly permission: string | null;
  readonly params?: z.AnyZodObject;
  readonly query?: z.AnyZodObject;
  readonly body?: z.ZodTypeAny;
  readonly responses: Readonly<Record<number, z.ZodTypeAny>>;
};

/** Chỉ để TypeScript giữ kiểu literal — không biến đổi gì. */
export function defineRoute<T extends RouteDescriptor>(r: T): T {
  return r;
}

export function toFastifyPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

export function pathParamNames(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "");
}
