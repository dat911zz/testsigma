# M2 — Identity/RBAC/Audit/Token + Authoring

> Căn cứ: blueprint §3 (multitenancy 3 lớp, 6 vai, token ∩ role), §2 (aut_*), §4 (concurrency).

- [x] Fastify 5 skeleton (zod type provider, AppError→HTTP, request context, composition root thật)
      — nền cho mọi route M2+ (hash: 9afbb30, 5fa3c9a, 73a5804)
- [x] Identity: users/memberships/api_tokens (SHA-256 + prefix, bắt buộc expiry) + email/password nội bộ
      + **generic OIDC SSO connector** (IdP: Keycloak self-host, chốt 28-08) (hash: a97b849, 70bbeba, 8914c8a, 98d693d)
- [ ] Cách ly L2.5: **Postgres RLS** policy theo team_id trên nhóm bảng asset (bổ sung composite FK, không thay thế)
- [x] RBAC: ma trận quyền TypeScript 6 vai; scope hiệu lực = token.scopes ∩ rolePerms mỗi request
      (cache 60s; action HIGH bỏ cache); danh sách never-grantable (hash: 27436f0, 73a5804)
- [ ] Cách ly L1: repository base đòi TenantContext (fail-closed) + lint cấm query builder thô
- [ ] Cách ly L2: composite FK (team_id, parent) toàn đồ thị asset
- [x] Cách ly L3: **bộ CI cross-tenant sinh từ OpenAPI — token B + id A ⇒ 404** (không bao giờ 403) (hash: 4eef1e0)
- [x] audit_events (partition tháng; app user không có DELETE grant) (hash: 8713291)
- [ ] Authoring: aut_cases (5 timestamp workflow đủ) / aut_steps / aut_step_loops / aut_rest_steps
      + revisions (zstd append-only) + reviews + advisory locks
- [ ] Four-eyes: người-sửa-cuối-không-tự-promote (trừ teams.allow_self_promote)
- [ ] Optimistic concurrency: version + ETag/If-Match (428 nếu thiếu), 409 kèm diff 3 chiều
- [x] Onboarding team = 1 transaction idempotent (quota + 3 env stub + team_admin + service account
      + seed egress observe 14d) (hash: f77d13a)

**Exit:** bộ T4 cách ly tenant xanh trên CI; tạo case → sửa → review → promote chạy trọn qua API.
