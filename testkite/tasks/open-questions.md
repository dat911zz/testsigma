# Câu hỏi mở — cập nhật sau vòng hỏi-đáp 27-08-2026

✅ **Đã chốt (xem bảng đầu blueprint):** nhân sự (+1 kỹ sư fleet, 9 tháng) · hạ tầng (tự host) ·
DB (**PostgreSQL 17**) · go-live 2–5 team · app đích chịu tải tốt · UI song ngữ vi+en (i18n từ đầu) ·
auth (email nội bộ + generic OIDC SSO) · retention (kết quả vĩnh viễn + partition tháng; ảnh/trace ≤30 ngày).

## Còn lại (không chặn M1, chốt dần theo milestone)

1. **IdP cụ thể cho SSO** (Keycloak / AD FS / Google Workspace / khác?) — cần trước M2 phần OIDC connector.
2. **Env đích để chạy test là gì:** staging clone hay production thật? (ảnh hưởng chính sách egress,
   tài khoản test, và rủi ro dây bẩn dữ liệu) — cần trước M3 pilot.
3. Pool tài khoản test: danh sách + cơ chế cấp phát (lease per-chain) — cần trước M3 pilot.
4. Chạy `SELECT entity_type, COUNT(*) FROM test_plans GROUP BY entity_type` (+ test_suites)
   trên production — chốt bộ suite/plan thật cho M7.
5. Pilot 200 chain đo giây/chain thật TRƯỚC khi mua/thuê máy (giả định 75s gánh mọi sizing) — đầu M3.
6. Mobile native vĩnh viễn ngoài scope — xác nhận lần cuối trước khi schema ship (M1).
7. Trần ngân sách AI/tháng lúc go-live — cần trước M5.
8. Chính sách quản trị catalog step-group công bố — trước khi team thứ 2 subscribe.
9. `test_devices.prerequisite_test_devices_id`: audit xác nhận không plan production nào dùng (M7).
10. UI cũ có từng surface review workflow chưa — chỉ ảnh hưởng truyền thông rollout (M8).
