-- Neo (connector, subject) -> user. Đường request đọc/ghi neo của chính team mình:
-- tra neo, tạo neo lần đầu, và xoá neo khi admin gỡ liên kết SSO.
GRANT SELECT, INSERT, UPDATE, DELETE ON idn_oidc_identities TO "testkite_app";
--> statement-breakpoint
-- KHÔNG cấp gì cho "testkite_auth": mọi truy cập bảng này xảy ra SAU khi đã biết
-- team (team của connector) nên luôn chạy dưới role app + app.team_id. Cấp thêm cho
-- role xác thực chỉ mở rộng bề mặt đọc xuyên-tenant mà không đổi lấy được gì.
