/**
 * Route của module identity. Handler nằm ở apps/core/src/modules/identity/routes.ts.
 * Bảng /v1 đầy đủ (~58 endpoint) sẽ lớn dần qua M3–M6; đây là lát đầu tiên.
 */
import { z } from "zod";
import { defineRoute, type RouteDescriptor } from "./types.js";

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  issues: z.array(z.string()).optional(),
});

const uuid = z.string().uuid();

export const membershipRoleSchema = z.enum([
  "instance_operator",
  "org_admin",
  "team_admin",
  "author",
  "runner",
  "viewer",
]);

export const apiTokenSchema = z.object({
  id: uuid,
  name: z.string(),
  prefix: z.string(),
  kind: z.enum(["user_pat", "service", "session"]),
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
});

/** Secret CHỈ trả về đúng một lần, lúc tạo. Không endpoint nào đọc lại được. */
export const apiTokenCreatedSchema = apiTokenSchema.extend({ secret: z.string() });

export const meSchema = z.object({
  userId: uuid.nullable(),
  teamId: uuid,
  role: membershipRoleSchema,
  scopes: z.array(z.string()),
  authKind: z.enum(["api_token", "session"]),
});

export const identityRoutes: readonly RouteDescriptor[] = [
  defineRoute({
    operationId: "loginPassword",
    method: "post",
    path: "/v1/auth/login",
    summary: "Đăng nhập email/mật khẩu nội bộ, trả session token của một team",
    auth: "public",
    permission: null,
    body: z.object({ email: z.string().email(), password: z.string().min(1), teamId: uuid.optional() }),
    responses: {
      200: z.object({ secret: z.string(), expiresAt: z.string().datetime(), context: meSchema }),
      401: errorResponseSchema,
    },
  }),
  defineRoute({
    operationId: "oidcStart",
    method: "post",
    path: "/v1/auth/oidc/{connectorId}/start",
    summary: "Bắt đầu authorization code + PKCE với IdP (Keycloak self-host)",
    auth: "public",
    permission: null,
    params: z.object({ connectorId: uuid }),
    body: z.object({ redirectUri: z.string().url() }),
    responses: { 200: z.object({ authorizationUrl: z.string().url(), state: z.string() }), 404: errorResponseSchema },
  }),
  defineRoute({
    operationId: "oidcCallback",
    method: "post",
    path: "/v1/auth/oidc/{connectorId}/callback",
    summary: "Đổi authorization code lấy session token",
    auth: "public",
    permission: null,
    params: z.object({ connectorId: uuid }),
    body: z.object({ callbackUrl: z.string().url() }),
    responses: {
      200: z.object({ secret: z.string(), expiresAt: z.string().datetime(), context: meSchema }),
      401: errorResponseSchema,
      404: errorResponseSchema,
    },
  }),
  defineRoute({
    operationId: "getMe",
    method: "get",
    path: "/v1/auth/me",
    summary: "Bối cảnh của credential đang dùng: team, vai, scope hiệu lực",
    auth: "required",
    permission: null,
    responses: { 200: meSchema, 401: errorResponseSchema },
  }),
  defineRoute({
    operationId: "listTokens",
    method: "get",
    path: "/v1/tokens",
    summary: "Liệt kê api token của team hiện tại",
    auth: "required",
    permission: "token:issue:user",
    responses: { 200: z.array(apiTokenSchema), 403: errorResponseSchema },
  }),
  defineRoute({
    operationId: "createToken",
    method: "post",
    path: "/v1/tokens",
    summary: "Phát api token mới — secret trả về đúng MỘT lần",
    auth: "required",
    permission: "token:issue:user",
    body: z.object({
      name: z.string().min(1).max(120),
      scopes: z.array(z.string()).min(1),
      // Hạn dùng BẮT BUỘC (blueprint §3) — không có nhánh nào cho token vô hạn.
      expiresInDays: z.number().int().min(1).max(365),
    }),
    responses: { 201: apiTokenCreatedSchema, 403: errorResponseSchema },
  }),
  defineRoute({
    operationId: "revokeToken",
    method: "delete",
    path: "/v1/tokens/{tokenId}",
    summary: "Thu hồi api token",
    auth: "required",
    permission: "token:issue:user",
    params: z.object({ tokenId: uuid }),
    responses: { 204: z.object({}), 403: errorResponseSchema, 404: errorResponseSchema },
  }),
  defineRoute({
    operationId: "listMembers",
    method: "get",
    path: "/v1/members",
    summary: "Thành viên của team hiện tại",
    auth: "required",
    permission: "member:manage",
    responses: {
      200: z.array(z.object({ userId: uuid, email: z.string(), role: membershipRoleSchema })),
      403: errorResponseSchema,
    },
  }),
  defineRoute({
    operationId: "setMemberRole",
    method: "patch",
    path: "/v1/members/{userId}",
    summary: "Đổi vai của một thành viên (action HIGH, bỏ cache, audit HIGH)",
    auth: "required",
    permission: "member:manage",
    params: z.object({ userId: uuid }),
    body: z.object({ role: membershipRoleSchema }),
    responses: {
      200: z.object({ userId: uuid, role: membershipRoleSchema }),
      403: errorResponseSchema,
      404: errorResponseSchema,
    },
  }),
  defineRoute({
    operationId: "onboardTeam",
    method: "post",
    path: "/v1/teams",
    summary: "Onboarding một team trong MỘT transaction idempotent",
    auth: "required",
    // DỰNG team mới là quyền cấp org, KHÔNG phải `team:manage` (thứ mọi team_admin đều
    // có): gộp hai thứ ấy là để bất kỳ team_admin nào cũng tự dựng team tuỳ ý.
    permission: "team:create",
    body: z.object({
      orgId: uuid,
      name: z.string().min(1).max(120),
      slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
      adminEmail: z.string().email(),
      /**
       * `.url()` một mình nhận CẢ ftp:/mailto:/file: — trong khi CHECK của
       * `pln_environments` chỉ cho http(s). Không chặn scheme ở đây thì một input sai
       * của client đi tới tận DB rồi bật lên thành 500 INTERNAL.
       */
      baseUrl: z.string().url().regex(/^https?:\/\//, "baseUrl phải dùng http hoặc https"),
      idempotencyKey: z.string().min(8).max(120),
    }),
    responses: {
      201: z.object({
        teamId: uuid,
        projectId: uuid,
        environmentIds: z.array(uuid),
        serviceTokenPrefix: z.string(),
        created: z.boolean(),
      }),
      400: errorResponseSchema,
      403: errorResponseSchema,
      /** slug đã có trong org, hoặc adminEmail trỏ vào một tài khoản đã tồn tại. */
      409: errorResponseSchema,
    },
  }),
  defineRoute({
    operationId: "listAuditEvents",
    method: "get",
    path: "/v1/audit-events",
    summary: "Đọc audit của team hiện tại (append-only, không xoá được)",
    auth: "required",
    permission: "audit:read",
    query: z.object({
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    responses: {
      200: z.array(
        z.object({
          id: uuid,
          occurredAt: z.string().datetime(),
          actorKind: z.enum(["user", "token", "system"]),
          actorId: uuid.nullable(),
          action: z.string(),
          severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
          targetKind: z.string().nullable(),
          targetId: uuid.nullable(),
        }),
      ),
      403: errorResponseSchema,
    },
  }),
];
