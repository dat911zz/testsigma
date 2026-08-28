-- drizzle-kit KHÔNG sinh thuộc tính role lẫn GRANT (xem 0002/0004/0006 của M1).
-- testkite_auth: quyền hẹp nhất có thể — CHỈ SELECT, CHỈ 3 bảng của đường xác thực.
-- Nó KHÔNG BYPASSRLS: nó đi qua policy `auth_lookup` của chính nó.
ALTER ROLE "testkite_auth" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_auth";
--> statement-breakpoint
GRANT SELECT ON api_tokens, memberships, users TO "testkite_auth";
--> statement-breakpoint
-- Đường request thật (testkite_app) quản lý token của chính team mình.
GRANT SELECT, INSERT, UPDATE, DELETE ON api_tokens TO "testkite_app";
