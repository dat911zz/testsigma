-- drizzle-kit KHÔNG sinh thuộc tính role lẫn GRANT (xem 0002/0004/0006 của M1).
-- testkite_auth: quyền hẹp nhất có thể — CHỈ SELECT, CHỈ các bảng của đường xác thực
-- (3 bảng ở đây; 0019 cấp thêm idn_oidc_connectors + idn_oidc_login_states ⇒ 5 bảng).
-- Nó KHÔNG BYPASSRLS: api_tokens/memberships đi qua policy `auth_lookup` của chính nó;
-- riêng `users` là NGOẠI LỆ — bảng này không bật RLS, quyền đọc đến thẳng từ GRANT dưới
-- đây (xem comment tại AUTH_ROLE trong kernel/db/schema.ts).
ALTER ROLE "testkite_auth" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_auth";
--> statement-breakpoint
GRANT SELECT ON api_tokens, memberships, users TO "testkite_auth";
--> statement-breakpoint
-- Đường request thật (testkite_app) quản lý token của chính team mình.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens TO "testkite_app";
