-- Phần drizzle-kit KHÔNG sinh: thuộc tính role + GRANT.
-- Vì sao không FORCE ROW LEVEL SECURITY: spike 2026-08-27 chứng minh FORCE không
-- chặn được superuser, và nó sẽ khiến chính migration/seed (chạy dưới owner) bị
-- policy chặn. Cơ chế thật: app kết nối bằng testkite_app — non-superuser,
-- KHÔNG phải owner của bảng ⇒ ENABLE là đủ.
ALTER ROLE "testkite_app" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, teams, projects, users, memberships TO "testkite_app";
