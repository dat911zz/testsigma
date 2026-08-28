/**
 * Routes for the identity module. Handlers live in apps/core/src/modules/identity/routes.ts.
 * The full /v1 surface (~58 endpoints) grows across M3–M6; this is the first slice.
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

/** Secret is returned EXACTLY once, at creation. No endpoint can read it back. */
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
      // Expiry is MANDATORY (blueprint §3) — there's no branch for an unlimited token.
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
    // CREATING a new team is an org-level permission, NOT `team:manage` (which every
    // team_admin already has): conflating the two would let any team_admin spin up
    // arbitrary new teams.
    permission: "team:create",
    body: z.object({
      orgId: uuid,
      name: z.string().min(1).max(120),
      slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
      adminEmail: z.string().email(),
      /**
       * `.url()` alone accepts ftp:/mailto:/file: too — while `pln_environments`'s
       * CHECK constraint only allows http(s). Not blocking the scheme here means a bad
       * client input reaches all the way to the DB and surfaces as a 500 INTERNAL.
       */
      baseUrl: z.string().url().regex(/^https?:\/\//, "baseUrl must use http or https"),
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
      /** slug already exists in the org, or adminEmail points to an existing account. */
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
