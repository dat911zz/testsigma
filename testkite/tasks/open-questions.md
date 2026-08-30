# Câu hỏi mở — cập nhật sau vòng hỏi-đáp 27-08-2026

✅ **Đã chốt (xem bảng đầu blueprint):** nhân sự (+1 kỹ sư fleet, 9 tháng) · hạ tầng (tự host) ·
DB (**PostgreSQL 17**) · go-live 2–5 team · app đích chịu tải tốt · UI song ngữ vi+en (i18n từ đầu) ·
auth (email nội bộ + generic OIDC SSO) · retention (kết quả vĩnh viễn + partition tháng; ảnh/trace ≤30 ngày).

## Còn lại (không chặn M1, chốt dần theo milestone)

1. ~~IdP cụ thể cho SSO~~ — ✅ **CHỐT 28-08-2026: Keycloak self-host** (dev/test: mock OIDC in-process; prod: Keycloak tự vận hành).
2. ~~Env đích để chạy test~~ — ✅ **CHỐT 28-08-2026: môi trường TEST/STAGING trước**, không chạy vào
   production. Hệ quả: egress allowlist trỏ host staging; rủi ro dây bẩn dữ liệu thật = 0 ở giai đoạn
   pilot; khi nào muốn chạy vào prod thì phải mở lại câu hỏi này kèm chính sách egress riêng.
3. ~~Cơ chế pool tài khoản test~~ — ✅ **CHỐT 28-08-2026: giữ đúng thiết kế lease-per-chain**
   (mỗi chain mượn 1 tài khoản trong suốt vòng đời, trả lại khi chain kết thúc kể cả khi lỗi).
   CÒN THIẾU (dữ liệu vận hành, không chặn implement): danh sách tài khoản staging cụ thể — nạp qua
   seed/config lúc chạy pilot 200 chain.
4. Chạy `SELECT entity_type, COUNT(*) FROM test_plans GROUP BY entity_type` (+ test_suites)
   trên production — chốt bộ suite/plan thật cho M7.
5. Pilot 200 chain đo giây/chain thật TRƯỚC khi mua/thuê máy (giả định 75s gánh mọi sizing) — đầu M3.
6. ~~Mobile native vĩnh viễn ngoài scope~~ — ✅ **XÁC NHẬN 28-08-2026: web-only vĩnh viễn**; schema/verb registry giữ web-only, mobile (nếu có) là milestone riêng với schema mở rộng.
7. Trần ngân sách AI/tháng lúc go-live — cần trước M5.
8. Chính sách quản trị catalog step-group công bố — trước khi team thứ 2 subscribe.
9. `test_devices.prerequisite_test_devices_id`: audit xác nhận không plan production nào dùng (M7).
10. UI cũ có từng surface review workflow chưa — chỉ ảnh hưởng truyền thông rollout (M8).
