-- APPEND-ONLY. Cố tình KHÔNG có UPDATE, KHÔNG có DELETE.
-- Đây là toàn bộ cơ chế bảo vệ lịch sử revision: quyền Postgres, không phải code
-- ứng dụng. Spike 2026-08-28 xác nhận GRANT SELECT,INSERT rồi UPDATE dưới role app
-- cho "permission denied for table". Ai muốn xoá lịch sử phải là owner DB —
-- và việc đó để lại dấu ở tầng hạ tầng, không lọt qua một bug API.
GRANT SELECT, INSERT ON aut_case_revisions TO "testkite_app";
