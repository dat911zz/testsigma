-- Phần drizzle-kit KHÔNG sinh: GRANT cho bảng mới (xem 0002_rls_hardening.sql).
-- RLS chỉ lọc row SAU KHI role đã có quyền trên bảng; thiếu GRANT thì testkite_app
-- nhận "permission denied" — không phải fail-closed đúng nghĩa.
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_cases TO "testkite_app";
