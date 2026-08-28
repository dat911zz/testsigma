-- audit_events: partition theo THÁNG, giữ 400 ngày (blueprint §2).
-- SQL VIẾT TAY vì drizzle-kit 0.31 không sinh được PARTITION BY. Bảng này CỐ Ý nằm
-- ngoài glob schema của drizzle.config.ts (xem governance/db/audit-schema.ts).
--
-- Bằng chứng spike 2026-08-28 chi phối mọi dòng dưới đây:
--  * PK BẮT BUỘC chứa partition key ("unique constraint on partitioned table must
--    include all partitioning columns") ⇒ PRIMARY KEY (team_id, id, occurred_at).
--  * GRANT trên CHA là đủ, kể cả cho partition tạo về sau.
--  * TUYỆT ĐỐI KHÔNG GRANT trên partition con: con có relrowsecurity=false, nên một
--    GRANT SELECT trên con cho phép đọc VƯỢT tenant (đã tái hiện: thấy cả row team B).
--  * Có default partition ⇒ không dùng được DETACH ... CONCURRENTLY; retention dùng
--    DETACH thường + DROP trong cửa sổ bảo trì. Đổi lại: không bao giờ mất một dòng
--    audit vì lệch dải (không default thì insert ngoài dải ném 23514).
CREATE TYPE "public"."audit_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');
--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'token', 'system');
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "team_id" uuid NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "actor_kind" "audit_actor_kind" NOT NULL,
  "actor_id" uuid,
  "action" text NOT NULL,
  "severity" "audit_severity" NOT NULL,
  "target_kind" text,
  "target_id" uuid,
  "request_id" text,
  "meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("team_id", "id", "occurred_at"),
  CONSTRAINT "audit_events_team_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE INDEX "audit_events_team_time_idx" ON "audit_events" ("team_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "audit_events_team_action_idx" ON "audit_events" ("team_id", "action", "occurred_at" DESC);
--> statement-breakpoint
-- Hàm tạo partition tháng, idempotent. KHÔNG có GRANT bên trong — xem cảnh báo đầu file.
CREATE OR REPLACE FUNCTION ensure_audit_partition(p_month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  start_ts timestamptz := date_trunc('month', p_month::timestamptz);
  end_ts   timestamptz := date_trunc('month', p_month::timestamptz) + interval '1 month';
  part     text := 'audit_events_' || to_char(start_ts, 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
    RETURN 'created ' || part;
  END IF;
  RETURN 'exists ' || part;
END $$;
--> statement-breakpoint
-- Tháng hiện tại + 13 tháng tới. Job hằng tháng (M6 observability) gọi lại hàm trên.
DO $$
DECLARE i int;
BEGIN
  FOR i IN 0..13 LOOP
    PERFORM ensure_audit_partition((date_trunc('month', now()) + (i || ' months')::interval)::date);
  END LOOP;
END $$;
--> statement-breakpoint
-- Lưới an toàn: bản ghi lệch dải rơi vào đây thay vì bị từ chối (23514).
CREATE TABLE "audit_events_default" PARTITION OF "audit_events" DEFAULT;
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
-- APPEND-ONLY Ở TẦNG QUYỀN: không UPDATE, không DELETE, không TRUNCATE.
-- Không dựa vào "code không gọi DELETE" — dựa vào việc DB từ chối.
GRANT SELECT, INSERT ON "audit_events" TO "testkite_app";
