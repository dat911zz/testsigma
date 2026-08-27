# M2 — Identity/RBAC/Audit/Token + Authoring

> Căn cứ: blueprint §3 (multitenancy 3 lớp, 6 vai, token ∩ role), §2 (aut_*), §4 (concurrency).

- [ ] Identity: users/memberships/api_tokens (SHA-256 + prefix, bắt buộc expiry) + login + Google OAuth
- [ ] RBAC: ma trận quyền TypeScript 6 vai; scope hiệu lực = token.scopes ∩ rolePerms mỗi request
      (cache 60s; action HIGH bỏ cache); danh sách never-grantable
- [ ] Cách ly L1: repository base đòi TenantContext (fail-closed) + lint cấm query builder thô
- [ ] Cách ly L2: composite FK (team_id, parent) toàn đồ thị asset
- [ ] Cách ly L3: **bộ CI cross-tenant sinh từ OpenAPI — token B + id A ⇒ 404** (không bao giờ 403)
- [ ] audit_events (partition tháng; app user không có DELETE grant)
- [ ] Authoring: aut_cases (5 timestamp workflow đủ) / aut_steps / aut_step_loops / aut_rest_steps
      + revisions (zstd append-only) + reviews + advisory locks
- [ ] Four-eyes: người-sửa-cuối-không-tự-promote (trừ teams.allow_self_promote)
- [ ] Optimistic concurrency: version + ETag/If-Match (428 nếu thiếu), 409 kèm diff 3 chiều
- [ ] Onboarding team = 1 transaction idempotent (quota + 3 env stub + team_admin + service account
      + seed egress observe 14d)

**Exit:** bộ T4 cách ly tenant xanh trên CI; tạo case → sửa → review → promote chạy trọn qua API.
