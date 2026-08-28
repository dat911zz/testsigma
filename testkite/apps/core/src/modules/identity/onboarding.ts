/**
 * Phần identity của onboarding: team + project mặc định + admin + service account.
 * Chạy trong TRANSACTION của onboarding (nhận `TkTx`, không nhận `TkDb`).
 */
import { and, eq, sql } from "drizzle-orm";
import { ConflictError } from "@testkite/contract";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { apiTokens, memberships, projects, teams, users } from "./db/schema.js";
import { issueApiToken } from "./auth/issue.js";

export type TeamCore = {
  readonly teamId: string;
  readonly projectId: string;
  readonly adminUserId: string;
  /** true = lần này thật sự tạo team; false = chạy lại idempotent trên team đã có. */
  readonly created: boolean;
  readonly serviceTokenPrefix: string;
  /**
   * Secret rời khỏi tiến trình ĐÚNG MỘT LẦN — chỉ ở lần tạo thật. Chạy lại idempotent
   * trả `null`: DB chỉ giữ sha256, không có đường đọc lại secret cũ.
   */
  readonly serviceToken: { readonly id: string; readonly prefix: string; readonly secret: string } | null;
};

export type ProvisionTeamInput = {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly adminEmail: string;
  readonly serviceTokenDays: number;
};

/** Scope của service account: chạy được test và đọc kết quả, KHÔNG sửa được gì. */
const SERVICE_SCOPES = ["run:trigger", "run:read", "case:read"] as const;

/**
 * `teamId` do CALLER sinh trước và đã nằm trong `app.team_id` — RLS trên `teams` là
 * `WITH CHECK (id = app.team_id)` nên không có cách nào khác (spike 2026-08-28).
 *
 * Idempotency ở đây là DO DB TRỌNG TÀI, không do đọc-rồi-ghi:
 *  - `ON CONFLICT DO NOTHING` (KHÔNG chỉ arbiter) nuốt cả đụng `id` (chạy lại cùng
 *    idempotencyKey) lẫn đụng `(org_id, slug)` (slug người khác đã lấy);
 *  - phân biệt hai ca ấy bằng đúng một câu SELECT dưới RLS: thấy team mang `id` của
 *    mình ⇒ chạy lại idempotent; không thấy ⇒ slug thuộc team KHÁC ⇒ 409.
 * Không bao giờ SELECT chéo tenant, và không có cửa sổ race nào giữa hai lệnh.
 */
export async function provisionTeamCore(
  tx: TkTx,
  ctx: TenantContext,
  input: ProvisionTeamInput,
  now: Date,
): Promise<TeamCore> {
  const teamId = assertTenantContext(ctx);
  const inserted = await tx
    .insert(teams)
    .values({ id: teamId, orgId: input.orgId, name: input.name, slug: input.slug })
    .onConflictDoNothing()
    .returning({ id: teams.id });
  const created = inserted[0] !== undefined;
  if (!created) {
    const mine = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1);
    if (mine[0] === undefined) throw new ConflictError(`slug đã dùng trong org: ${input.slug}`);
  }

  const proj = await tx
    .insert(projects)
    .values({ teamId, name: "Default", slug: "default" })
    .onConflictDoNothing({ target: [projects.teamId, projects.slug] })
    .returning({ id: projects.id });
  const projectId =
    proj[0]?.id ??
    (await tx.select({ id: projects.id }).from(projects).where(eq(projects.teamId, teamId)).limit(1))[0]?.id;
  if (projectId === undefined) throw new Error("onboarding: không tạo được project");

  // `users` là bảng TOÀN CỤC: người này có thể đã là thành viên team khác từ trước.
  const email = input.adminEmail.toLowerCase();
  const existingUser = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  const adminUserId =
    existingUser[0]?.id ??
    (
      await tx
        .insert(users)
        .values({ email, displayName: email.split("@")[0] ?? email })
        .onConflictDoNothing()
        .returning({ id: users.id })
    )[0]?.id;
  if (adminUserId === undefined) throw new Error("onboarding: không tạo được admin user");

  await tx
    .insert(memberships)
    .values({ teamId, userId: adminUserId, role: "team_admin" })
    .onConflictDoNothing({ target: [memberships.teamId, memberships.userId] });

  // Token CHỈ phát ở lần tạo thật: chạy lại idempotent không được rải thêm credential.
  if (created) {
    const minted = await issueApiToken(
      tx,
      { teamId },
      {
        name: "service-account",
        scopes: SERVICE_SCOPES,
        expiresInDays: input.serviceTokenDays,
        kind: "service",
        userId: null,
        createdBy: null,
      },
      now,
    );
    return {
      teamId,
      projectId,
      adminUserId,
      created,
      serviceTokenPrefix: minted.prefix,
      serviceToken: { id: minted.id, prefix: minted.prefix, secret: minted.secret },
    };
  }

  const existingToken = await tx
    .select({ prefix: apiTokens.prefix })
    .from(apiTokens)
    .where(and(eq(apiTokens.teamId, teamId), eq(apiTokens.kind, "service")))
    .orderBy(apiTokens.createdAt)
    .limit(1);
  const prefix = existingToken[0]?.prefix;
  if (prefix === undefined) throw new Error("onboarding: team đã có nhưng thiếu service account");
  return { teamId, projectId, adminUserId, created, serviceTokenPrefix: prefix, serviceToken: null };
}
