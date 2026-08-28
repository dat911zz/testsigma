/**
 * Module orchestration — egress_policies (bản M2 tối thiểu cho onboarding).
 * blueprint §5: hardening tier 0 = egress default-deny per-tenant, nhưng bật ở chế độ
 * OBSERVE 14 ngày trước khi enforce (S8) — seed nằm trong chính transaction onboard.
 *
 * LỆCH CÓ CHỦ ĐÍCH so với block schema trong plan (Task 10, Step 3): thêm
 * `unique(team_id)`. Plan viết seed là `ON CONFLICT (team_id, id) DO NOTHING`, nhưng
 * `id` là `gen_random_uuid()` nên cặp ấy KHÔNG BAO GIỜ đụng — gọi onboard lần hai sẽ
 * lặng lẽ thêm policy egress thứ hai cho cùng một team, đúng thứ mà task này (và test
 * "KHÔNG nhân đôi gì") cấm. M2 mỗi tenant đúng MỘT chính sách egress, nên để DB canh
 * điều đó thay vì trông vào việc người gọi nhớ kiểm tra trước. Khi M5 cần nhiều
 * policy mỗi team, bỏ ràng buộc này cùng lúc với việc thêm khoá phân biệt thật.
 */
import { sql } from "drizzle-orm";
import { index, pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const egressMode = pgEnum("egress_mode", ["observe", "enforce"]);

export const egressPolicies = pgTable(
  "egress_policies",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    mode: egressMode("mode").notNull().default("observe"),
    allowlist: text("allowlist").array().notNull(),
    observeUntil: timestamp("observe_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("egress_policies_team_id_unique").on(t.teamId, t.id),
    unique("egress_policies_team_unique").on(t.teamId),
    index("egress_policies_team_idx").on(t.teamId),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
