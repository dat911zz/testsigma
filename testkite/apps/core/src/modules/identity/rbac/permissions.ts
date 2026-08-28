/**
 * RBAC = a TypeScript matrix, NOT a grants table in the DB (blueprint §3).
 * Changing permissions = changing code = going through review = shows up in git blame.
 * Nobody "hot-patches" permissions.
 */

export const PERMISSIONS = [
  "case:read", "case:write", "case:promote",
  "suite:read", "suite:write",
  "run:read", "run:trigger", "run:abort",
  "element:read", "element:propose", "element:write",
  "testdata:read", "testdata:write",
  "env:read", "env:write",
  "secret:read", "secret:write",
  "member:manage", "team:manage", "team:create", "team:purge",
  "token:issue:user", "token:issue:service",
  "quota:read", "quota:set",
  "audit:read", "audit:read:all",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type MembershipRole =
  | "instance_operator" | "org_admin" | "team_admin" | "author" | "runner" | "viewer";

const VIEWER: readonly Permission[] = [
  "case:read", "suite:read", "run:read", "element:read", "testdata:read", "env:read",
];

/** runner = CI: presses the run button and reads results, CANNOT edit tests. */
const RUNNER: readonly Permission[] = [...VIEWER, "run:trigger", "run:abort"];

const AUTHOR: readonly Permission[] = [
  ...RUNNER,
  "case:write", "case:promote", "suite:write",
  // element:write is never-grantable ⇒ author proposes, cannot write directly (blueprint §3, S5).
  "element:propose",
  "testdata:write",
  "token:issue:user",
];

/**
 * `team:manage` = administering a team that ALREADY EXISTS (change its config, manage its
 * members). It does NOT cover CREATING a new team: creating a team is an org-level action
 * (pick the org, set quotas, designate the first admin), so it stands apart as
 * `team:create`. Merging the two would be a privilege-escalation path: every team_admin
 * has `team:manage`, so every team_admin could spin up a new team for themselves and hand
 * out admin to whoever they like.
 */
const TEAM_ADMIN: readonly Permission[] = [
  ...AUTHOR,
  "member:manage", "team:manage",
  "env:write", "secret:read", "secret:write",
  "quota:read", "audit:read",
];

/**
 * org_admin does NOT read team assets by default — reading requires break-glass, and
 * break-glass writes a HIGH audit entry (blueprint §3). This role manages people + quotas,
 * it doesn't view tests.
 */
const ORG_ADMIN: readonly Permission[] = [
  "member:manage", "team:manage", "team:create",
  "quota:read", "quota:set", "audit:read", "audit:read:all",
];

/** Infra role: operates the instance, not a business user. */
const INSTANCE_OPERATOR: readonly Permission[] = [
  ...ORG_ADMIN, "team:purge", "token:issue:service",
];

export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  instance_operator: INSTANCE_OPERATOR,
  org_admin: ORG_ADMIN,
  team_admin: TEAM_ADMIN,
  author: AUTHOR,
  runner: RUNNER,
  viewer: VIEWER,
};

/**
 * Can NEVER be attached to a non-interactive credential (api token kind user_pat/service).
 * Copied verbatim from blueprint §3. A real human sitting at the keyboard (kind=session)
 * can still use it if their role has it, but every use is a HIGH audit line and bypasses
 * the cache.
 */
export const NEVER_GRANTABLE: readonly Permission[] = [
  "secret:write", "quota:set", "element:write", "token:issue:service", "team:purge",
];

/** HIGH actions: bypass the 60s cache, always hit the DB, always write audit severity=HIGH. */
export const HIGH_RISK: readonly Permission[] = [
  ...NEVER_GRANTABLE,
  "member:manage", "team:manage", "team:create", "secret:read", "audit:read:all", "token:issue:user",
];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const NEVER_SET: ReadonlySet<string> = new Set(NEVER_GRANTABLE);
const HIGH_SET: ReadonlySet<string> = new Set(HIGH_RISK);

export function isPermission(x: string): x is Permission {
  return PERMISSION_SET.has(x);
}
export function isNeverGrantable(x: string): boolean {
  return NEVER_SET.has(x);
}
export function isHighRisk(x: string): boolean {
  return HIGH_SET.has(x);
}
