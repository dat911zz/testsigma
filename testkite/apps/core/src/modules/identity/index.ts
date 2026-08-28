/**
 * Module: identity
 * Owned tables: organizations, teams, projects, users, memberships, api_tokens, mcp_clients, oauth_grants, element_proposals, idn_
 *
 * Quy tắc (docs/SYSTEM_DESIGN.md §4):
 *  - Gọi XUÔI theo DAG = import facade (file này). Gọi NGƯỢC/NGANG = domain event qua transactional outbox.
 *  - Không module nào khác được đụng bảng của module này (ownership.json + eslint-boundaries cưỡng chế).
 *  - Repository phải khởi tạo với TenantContext (fail-closed) — xem lớp cách ly L1.
 */
export const MODULE = "identity" as const;

// Facade công khai của identity. Module khác (authoring, planning, ...) chỉ được
// import từ file này — không bao giờ với tay vào `./db/schema.js`.
export { hashPassword, verifyPassword, needsRehash, passwordPolicy, PASSWORD_MIN_LENGTH } from "./auth/password.js";
export { users, memberships, teams, organizations, membershipRole, userStatus } from "./db/schema.js";
export { projects } from "./db/schema.js";
export { apiTokens, apiTokenKind } from "./db/schema.js";
export {
  mintTokenSecret,
  hashTokenSecret,
  parseTokenSecret,
  expiryFromDays,
  MAX_TOKEN_TTL_DAYS,
  type MintedToken,
} from "./auth/token.js";
export {
  PERMISSIONS, ROLE_PERMISSIONS, NEVER_GRANTABLE, HIGH_RISK,
  isPermission, isNeverGrantable, isHighRisk,
  type Permission, type MembershipRole,
} from "./rbac/permissions.js";
export { authorize, assertGrantable, effectiveScopes, type CredentialKind } from "./rbac/authorize.js";
export {
  createAuthenticator,
  type AuthenticatedPrincipal,
  type Authenticator,
  type AuthenticatorDeps,
} from "./auth/authenticator.js";
export { createAuthzCache, AUTHZ_CACHE_TTL_MS, type AuthzCache, type CachedGrant } from "./rbac/cache.js";
export {
  issueApiToken,
  revokeApiToken,
  type IssueTokenInput,
  type MintedApiToken,
} from "./auth/issue.js";
export {
  loginWithPassword,
  SESSION_TTL_DAYS,
  LOGIN_FAILED_MESSAGE,
  type DeferPort,
  type LoginDeps,
  type LoginResult,
} from "./auth/login.js";
export {
  provisionTeamCore,
  type ProvisionTeamInput,
  type TeamCore,
} from "./onboarding.js";
// Cổng audit: tầng shell tiêm `writeAuditEvent` của governance vào đây (audit-port.ts).
export type { AuditEvent, AuditEventActorKind, AuditEventSeverity, AuditPort } from "./audit-port.js";
