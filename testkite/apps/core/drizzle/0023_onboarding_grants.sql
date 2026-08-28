-- GRANT cho ba bảng mới của onboarding (drizzle-kit không sinh — xem 0002/0004/0006/0016).
-- Đường request thật (testkite_app) ghi cả ba trong CÙNG transaction onboarding;
-- policy `tenant_isolation` của mỗi bảng vẫn ghim mọi hàng vào app.team_id.
--
-- testkite_auth KHÔNG có tên ở đây một cách CÓ CHỦ ĐÍCH: đường xác thực chỉ tra
-- credential (api_tokens/memberships/users), không đọc hạn mức, environment hay egress.
GRANT SELECT, INSERT, UPDATE, DELETE ON quota_limits, pln_environments, egress_policies TO "testkite_app";
