/**
 * Đăng nhập email/mật khẩu nội bộ.
 *
 * Luật chống dò tài khoản: MỌI nhánh thất bại (email không có, mật khẩu sai, user
 * suspend, không là thành viên team được xin) đều trả CÙNG MỘT UnauthorizedError với
 * cùng message. Đường thất bại vẫn chạy một lần verify giả để thời gian phản hồi
 * không tố cáo "email này không tồn tại".
 *
 * Quyết định có chủ đích — session LÀ api_token `kind='session'`: không bảng phiên,
 * không cookie/CSRF trong M2. Một secret hạn 1 ngày gắn ĐÚNG một team; đổi team =
 * đăng nhập lại. Đổi lại, nó là credential duy nhất được mang never-grantable (người
 * thật đang ngồi trước máy — xem `effectiveScopes`). Khi UI thật ra đời ở M4, đây là
 * chỗ xem lại (cookie httpOnly + CSRF) và ghi vào docs/ARCHITECTURE_AUDIT.md.
 *
 * `audit` là CỔNG tiêm từ tầng shell, không phải import: identity và governance cùng
 * tầng DAG nên identity không được import governance (xem ../audit-port.ts).
 */
import { eq, sql } from "drizzle-orm";
import { UnauthorizedError } from "@testkite/contract";
import { withAuthRole, withTenant, type TkDb } from "../../kernel/index.js";
import type { AuditPort } from "../audit-port.js";
import { memberships, users } from "../db/schema.js";
import { effectiveScopes } from "../rbac/authorize.js";
import { ROLE_PERMISSIONS, type MembershipRole, type Permission } from "../rbac/permissions.js";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { issueApiToken } from "./issue.js";

export const SESSION_TTL_DAYS = 1;

/**
 * Một message duy nhất cho mọi nhánh thất bại. (Client thấy câu chung của
 * error handler vì UnauthorizedError không tenantVisible — nhưng ngay cả log nội bộ
 * cũng không được phân biệt "email không tồn tại" với "mật khẩu sai".)
 */
export const LOGIN_FAILED_MESSAGE = "email hoặc mật khẩu không đúng";

/** Hash mồi để nhánh "không có user" tốn đúng chừng ấy thời gian như nhánh có user. */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type LoginResult = {
  readonly secret: string;
  readonly expiresAt: Date;
  readonly teamId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
};

export type LoginDeps = {
  readonly db: TkDb;
  readonly audit: AuditPort;
  readonly now?: () => Date;
};

export async function loginWithPassword(
  deps: LoginDeps,
  input: { readonly email: string; readonly password: string; readonly teamId?: string },
): Promise<LoginResult> {
  const clock = deps.now ?? ((): Date => new Date());
  const fail = new UnauthorizedError(LOGIN_FAILED_MESSAGE);

  // Pha 1 chạy bằng role testkite_auth: lúc này CHƯA biết tenant, mà đó chính là
  // thứ đang đi tìm. Role đó chỉ SELECT được users/memberships/api_tokens.
  const found = await withAuthRole(deps.db, async (tx) => {
    const rows = await tx
      .select({ id: users.id, hash: users.passwordHash, status: users.status })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${input.email})`)
      .limit(1);
    const u = rows[0];
    // password_hash NULL = tài khoản chỉ đăng nhập bằng OIDC ⇒ 401, không 500.
    if (u === undefined || u.hash === null || u.status !== "active") return null;
    const hash = u.hash;
    const mem = await tx
      .select({
        teamId: memberships.teamId,
        role: memberships.role,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .where(eq(memberships.userId, u.id))
      .orderBy(memberships.createdAt);
    return { userId: u.id, hash, memberships: mem };
  });

  if (found === null) {
    await verifyPassword(DUMMY_HASH, input.password); // đốt thời gian tương đương
    throw fail;
  }
  if (!(await verifyPassword(found.hash, input.password))) {
    await auditFailure(deps, found.memberships[0]?.teamId, input.email, clock());
    throw fail;
  }

  const picked =
    input.teamId === undefined
      ? found.memberships[0]
      : found.memberships.find((m) => m.teamId === input.teamId);
  // Không phải thành viên ⇒ 401, KHÔNG xác nhận team đó có tồn tại hay không.
  if (picked === undefined) throw fail;

  const teamId = picked.teamId;
  const role: MembershipRole = picked.role;
  // Session của người thật mang trọn quyền của vai (effectiveScopes lọc lại lần cuối).
  const scopes = effectiveScopes(role, ROLE_PERMISSIONS[role], "session");
  const at = clock();

  return withTenant(deps.db, { teamId }, async (tx) => {
    const minted = await issueApiToken(
      tx,
      { teamId },
      {
        name: "session",
        scopes,
        expiresInDays: SESSION_TTL_DAYS,
        kind: "session",
        userId: found.userId,
        createdBy: found.userId,
      },
      at,
    );
    // Rehash im lặng khi tham số argon2 của hash cũ yếu hơn tham số hiện hành —
    // gộp chung một UPDATE với last_login_at, cùng transaction với phiên vừa phát.
    const rehash = needsRehash(found.hash)
      ? { passwordHash: await hashPassword(input.password), updatedAt: at }
      : {};
    await tx
      .update(users)
      .set({ lastLoginAt: at, ...rehash })
      .where(eq(users.id, found.userId));
    await deps.audit(tx, { teamId }, {
      actorKind: "user",
      actorId: found.userId,
      action: "auth.login",
      severity: "LOW",
      targetKind: "api_token",
      targetId: minted.id,
    });
    return {
      secret: minted.secret,
      expiresAt: minted.expiresAt,
      teamId,
      userId: found.userId,
      role,
      scopes,
    };
  });
}

/**
 * Đăng nhập hỏng vẫn phải để lại dấu vết — nhưng audit_events là bảng TENANT-SCOPED:
 * không biết tenant thì không có chỗ ghi. Người không tồn tại vì thế không sinh audit
 * (và cũng không được sinh: đó sẽ là kênh dò tài khoản qua chính bảng audit).
 */
async function auditFailure(
  deps: LoginDeps,
  teamId: string | undefined,
  email: string,
  now: Date,
): Promise<void> {
  if (teamId === undefined) return;
  await withTenant(deps.db, { teamId }, async (tx) => {
    await deps.audit(tx, { teamId }, {
      actorKind: "user",
      actorId: null,
      action: "auth.login_failed",
      severity: "MEDIUM",
      meta: { email, at: now.toISOString() },
    });
  });
}
