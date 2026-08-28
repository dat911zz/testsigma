/**
 * Sổ đăng ký route toàn hệ.
 *
 * THỨ TỰ QUAN TRỌNG: nó là thứ tự key `paths` trong openapi.json đã commit, mà gate
 * drift so BYTE. Module mới nối vào CUỐI mảng, không chèn giữa.
 */
import { identityRoutes } from "./identity.js";
import type { RouteDescriptor } from "./types.js";

export * from "./types.js";
export { errorResponseSchema, identityRoutes } from "./identity.js";

export const ROUTES: readonly RouteDescriptor[] = [
  ...identityRoutes,
  // authoring nối đúng MỘT dòng vào đây: ...authoringRoutes
];
