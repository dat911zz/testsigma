/**
 * Effective scope = token.scopes ∩ ROLE_PERMISSIONS[role], recomputed on EVERY REQUEST.
 * Intended consequence: demoting someone's role strips every one of their tokens'
 * permissions instantly — no need to revoke tokens one by one, no window where a
 * "token still holds the old permissions".
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
    if (!isPermission(s)) continue;             // stale/garbage scope: skip, don't break the request
    if (!rolePerms.has(s)) continue;            // token asks for more than the role grants: trim it
    if (kind !== "session" && isNeverGrantable(s)) continue; // never-grantable: real humans only
    out.push(s);
  }
  return out;
}

/** Gate at token ISSUE time — never-grantable must never be written into api_tokens.scopes. */
export function assertGrantable(scopes: readonly string[]): asserts scopes is readonly Permission[] {
  const bad = scopes.filter((s) => !isPermission(s) || isNeverGrantable(s));
  if (bad.length > 0) {
    throw new ForbiddenError(`scope not allowed on a token: ${bad.join(", ")}`);
  }
}

export function authorize(
  role: MembershipRole,
  effective: readonly Permission[],
  required: string | null,
): void {
  if (required === null) return;
  if (!isPermission(required)) throw new ForbiddenError(`permission does not exist: ${required}`);
  if (!effective.includes(required)) {
    throw new ForbiddenError(`missing permission ${required} for role ${role}`);
  }
}
