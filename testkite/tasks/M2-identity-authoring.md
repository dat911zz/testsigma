# M2 — Identity/RBAC/Audit/Token + Authoring

> Căn cứ: blueprint §3 (multitenancy 3 lớp, 6 vai, token ∩ role), §2 (aut_*), §4 (concurrency).

- [x] Fastify 5 skeleton (zod type provider, AppError→HTTP, request context, composition root thật)
      — nền cho mọi route M2+ (hash: 9afbb30, 5fa3c9a, 73a5804)
- [x] Identity: users/memberships/api_tokens (SHA-256 + prefix, bắt buộc expiry) + email/password nội bộ
      + **generic OIDC SSO connector** (IdP: Keycloak self-host, chốt 28-08) (hash: a97b849, 70bbeba, 8914c8a, 98d693d)
- [x] Cách ly L2.5: **Postgres RLS** policy theo team_id trên nhóm bảng asset (bổ sung composite FK, không thay thế)
      — 17 bảng bật RLS gồm đủ 6 bảng `aut_*` (hash: 1e1cda9, 030fb0b, 7bc9c40, 18b192a; identity: 70bbeba, 8713291, 98d693d)
- [x] RBAC: ma trận quyền TypeScript 6 vai; scope hiệu lực = token.scopes ∩ rolePerms mỗi request
      (cache 60s; action HIGH bỏ cache); danh sách never-grantable (hash: 27436f0, 73a5804)
- [ ] Cách ly L1: repository base đòi TenantContext (fail-closed) ✅ (hash: 1306341 — `assertTenantContext`
      + `TenantRepo`) **+ lint cấm query builder thô ❌ CHƯA CÓ** — eslint hiện chỉ gác queue-client và
      compiler-pure; thiếu luật chặn gọi thẳng `db.select/insert/update/delete` trên handle thô ngoài
      `withTenant`/`TenantRepo`. Giao cho wave polish M2 (kiểm chứng 28-08 bởi tổng kiến trúc sư).
- [x] Cách ly L2: composite FK (team_id, parent) toàn đồ thị asset — 13 composite FK phủ đồ thị `aut_*`
      (hash: 9218d72, f55e6aa, 030fb0b, 7bc9c40, 18b192a)
- [x] Cách ly L3: **bộ CI cross-tenant sinh từ OpenAPI — token B + id A ⇒ 404** (không bao giờ 403) (hash: 4eef1e0)
- [x] audit_events (partition tháng; app user không có DELETE grant) (hash: 8713291)
- [x] Authoring: aut_cases (5 timestamp workflow đủ) / aut_steps / aut_step_loops / aut_rest_steps
      + revisions (zstd append-only) + reviews + advisory locks
      (hash: 1e1cda9, 030fb0b, 7bc9c40, 18b192a, 6bf6bcc)
- [x] Four-eyes: người-sửa-cuối-không-tự-promote (trừ teams.allow_self_promote) (hash: 6bf6bcc)
- [x] Optimistic concurrency: version + ETag/If-Match (428 nếu thiếu), 409 kèm diff 3 chiều
      (hash: 6024b1c, ca09804, 9370218)
- [x] Onboarding team = 1 transaction idempotent (quota + 3 env stub + team_admin + service account
      + seed egress observe 14d) (hash: f77d13a)

**Exit:** bộ T4 cách ly tenant xanh trên CI; tạo case → sửa → review → promote chạy trọn qua API — ✅ XANH (hash: 3a9f8c2, 4abe6cd; test test/authoring/routes.test.ts "create -> edit steps -> submit -> review -> promote, over HTTP only").
