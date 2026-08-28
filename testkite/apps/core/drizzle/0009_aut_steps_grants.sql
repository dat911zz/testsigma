-- Phần drizzle-kit KHÔNG sinh: GRANT (xem 0002_rls_hardening.sql).
-- RLS chỉ lọc row SAU KHI role đã có quyền trên bảng; thiếu GRANT thì testkite_app
-- nhận "permission denied" — không phải fail-closed đúng nghĩa.
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_steps TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_step_loops TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON aut_rest_steps TO "testkite_app";
