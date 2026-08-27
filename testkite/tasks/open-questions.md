# Câu hỏi mở — cần maintainer chốt

⚠️ **2 câu CHẶN M1:**
1. **Nhân sự:** +1 kỹ sư fleet (lịch 9 tháng) hay solo (~12 tháng)?
2. **Hạ tầng:** cloud (~$900–1.000/th all-in lúc go-live) hay tự host Hetzner-class (~$350–450, ~6× rẻ phần compute)? — quyết trước khi provision M3.

Còn lại:
3. Chạy `SELECT entity_type, COUNT(*) FROM test_plans GROUP BY entity_type` (+ test_suites) trên production — chốt kích thước migrate M7.
4. Chính sách lịch sử kết quả: 90 ngày full + rollup vĩnh viễn — xác nhận.
5. Pilot 200 chain đo giây/chain thật TRƯỚC khi mua máy (giả định 75s đang gánh mọi con số sizing).
6. Mobile native vĩnh viễn ngoài scope — xác nhận trước khi schema ship (cột Appium bỏ không migrate).
7. Trần ngân sách AI/tháng lúc go-live ($200 trong opex là placeholder).
8. Chính sách quản trị catalog step-group công bố — trước khi team thứ 2 subscribe.
9. `test_devices.prerequisite_test_devices_id`: audit xác nhận không plan production nào dùng trước khi bỏ.
10. UI cũ có từng surface review workflow chưa (review_submitted_at chưa từng persist) — ảnh hưởng truyền thông rollout.
