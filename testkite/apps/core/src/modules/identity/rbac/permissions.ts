/**
 * RBAC = ma trận TypeScript, KHÔNG bảng grants trong DB (blueprint §3).
 * Đổi quyền = đổi code = qua review = có trong git blame. Không ai "sửa quyền nóng".
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

/** runner = CI: bấm nút chạy và đọc kết quả, KHÔNG sửa được test. */
const RUNNER: readonly Permission[] = [...VIEWER, "run:trigger", "run:abort"];

const AUTHOR: readonly Permission[] = [
  ...RUNNER,
  "case:write", "case:promote", "suite:write",
  // element:write là never-grantable ⇒ author đề xuất, không tự ghi (blueprint §3, S5).
  "element:propose",
  "testdata:write",
  "token:issue:user",
];

/**
 * `team:manage` = quản trị team ĐANG CÓ (đổi cấu hình, quản người trong đó). Nó KHÔNG
 * bao hàm việc DỰNG team mới: dựng team là hành vi cấp org (chọn org, cấp hạn mức, chỉ
 * định admin đầu tiên) nên đứng riêng thành `team:create`. Gộp hai thứ này là đường leo
 * thang: mọi team_admin đều có `team:manage`, tức mọi team_admin đều tự cấp cho mình
 * một team mới và tự gắn admin cho người khác.
 */
const TEAM_ADMIN: readonly Permission[] = [
  ...AUTHOR,
  "member:manage", "team:manage",
  "env:write", "secret:read", "secret:write",
  "quota:read", "audit:read",
];

/**
 * org_admin KHÔNG đọc tài sản team mặc nhiên — muốn đọc thì break-glass, và
 * break-glass ghi audit HIGH (blueprint §3). Vai này quản người + hạn mức, không xem test.
 */
const ORG_ADMIN: readonly Permission[] = [
  "member:manage", "team:manage", "team:create",
  "quota:read", "quota:set", "audit:read", "audit:read:all",
];

/** Vai hạ tầng: vận hành instance, không phải người dùng nghiệp vụ. */
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
 * KHÔNG BAO GIỜ gắn được vào credential không tương tác (api token kind user_pat/service).
 * Sao nguyên văn blueprint §3. Người thật đang ngồi trước máy (kind=session) vẫn dùng
 * được nếu vai của họ có, nhưng mỗi lần dùng là một dòng audit HIGH và bỏ qua cache.
 */
export const NEVER_GRANTABLE: readonly Permission[] = [
  "secret:write", "quota:set", "element:write", "token:issue:service", "team:purge",
];

/** Action HIGH: bỏ qua cache 60s, luôn đọc DB, luôn ghi audit severity=HIGH. */
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
