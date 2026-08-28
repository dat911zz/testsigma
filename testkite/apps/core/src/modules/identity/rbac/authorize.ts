/**
 * Scope hiệu lực = token.scopes ∩ ROLE_PERMISSIONS[role], tính LẠI MỖI REQUEST.
 * Hệ quả cố ý: hạ vai một người là tước quyền mọi token của họ tức thì — không phải
 * đi thu hồi từng token, không có cửa sổ "token còn quyền cũ".
 */
import { ForbiddenError } from "@testkite/contract";
import {
  ROLE_PERMISSIONS, isNeverGrantable, isPermission,
  type MembershipRole, type Permission,
} from "./permissions.js";

export type CredentialKind = "user_pat" | "service" | "session";

export function effectiveScopes(
  role: MembershipRole,
  tokenScopes: readonly string[],
  kind: CredentialKind = "user_pat",
): readonly Permission[] {
  const rolePerms = new Set<string>(ROLE_PERMISSIONS[role]);
  const out: Permission[] = [];
  for (const s of tokenScopes) {
    if (!isPermission(s)) continue;             // scope rác/cũ: bỏ qua, không vỡ request
    if (!rolePerms.has(s)) continue;            // token xin rộng hơn vai: cắt
    if (kind !== "session" && isNeverGrantable(s)) continue; // never-grantable: chỉ người thật
    out.push(s);
  }
  return out;
}

/** Gate lúc PHÁT token — never-grantable không bao giờ được ghi vào api_tokens.scopes. */
export function assertGrantable(scopes: readonly string[]): asserts scopes is readonly Permission[] {
  const bad = scopes.filter((s) => !isPermission(s) || isNeverGrantable(s));
  if (bad.length > 0) {
    throw new ForbiddenError(`scope không được phép gắn vào token: ${bad.join(", ")}`);
  }
}

export function authorize(
  role: MembershipRole,
  effective: readonly Permission[],
  required: string | null,
): void {
  if (required === null) return;
  if (!isPermission(required)) throw new ForbiddenError(`permission không tồn tại: ${required}`);
  if (!effective.includes(required)) {
    throw new ForbiddenError(`thiếu quyền ${required} với vai ${role}`);
  }
}
