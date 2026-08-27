-- Least privilege: đường ghi (app) chỉ INSERT; đường đọc (relay) không đụng bảng nghiệp vụ.
ALTER ROLE "testkite_relay" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_relay";
--> statement-breakpoint
GRANT INSERT ON krn_outbox TO "testkite_app";
--> statement-breakpoint
-- Cột-level, KHÔNG phải SELECT cả bảng: Postgres đòi quyền SELECT trên mọi cột nằm
-- trong RETURNING, nên `INSERT ... RETURNING id` sẽ 42501 nếu chỉ có GRANT INSERT
-- (đã tái hiện thật trên PGlite 18.3). Chỉ mở đúng cột `id` ⇒ writer lấy được id để
-- relay sắp thứ tự, còn `SELECT * FROM krn_outbox` vẫn permission denied: role app
-- KHÔNG đọc được payload/team_id của bất kỳ event nào, kể cả của chính mình.
GRANT SELECT ("id") ON krn_outbox TO "testkite_app";
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE krn_outbox_id_seq TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON krn_outbox TO "testkite_relay";
--> statement-breakpoint
GRANT SELECT, INSERT ON krn_outbox_consumed TO "testkite_relay";
