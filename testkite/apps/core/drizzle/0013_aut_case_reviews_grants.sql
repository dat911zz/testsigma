-- Phần drizzle-kit KHÔNG sinh: GRANT (xem 0002_rls_hardening.sql).
-- Review CÓ UPDATE (đóng review = đổi state) nhưng KHÔNG có DELETE: lịch sử ai
-- yêu cầu, ai duyệt, duyệt lúc nào là bằng chứng four-eyes — xoá được thì four-eyes
-- chỉ còn là lời kể.
GRANT SELECT, INSERT, UPDATE ON aut_case_reviews TO "testkite_app";
