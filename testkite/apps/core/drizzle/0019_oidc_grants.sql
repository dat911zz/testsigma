-- Đường request quản lý connector/state của chính team mình.
GRANT SELECT, INSERT, UPDATE, DELETE ON idn_oidc_connectors, idn_oidc_login_states TO "testkite_app";
--> statement-breakpoint
-- Đường xác thực CHỈ ĐỌC: /v1/auth/oidc/* là route public, chưa có tenant ctx khi
-- tra connector và state. Ghi (tạo state, đánh dấu consumed) vẫn đi qua testkite_app
-- sau khi đã biết team_id — role này không bao giờ ghi được gì.
GRANT SELECT ON idn_oidc_connectors, idn_oidc_login_states TO "testkite_auth";
