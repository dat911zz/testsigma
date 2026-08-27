/**
 * Module authoring — bảng asset ĐẦU TIÊN, dựng làm MẪU cho ~50 bảng còn lại.
 * Ba thứ mọi bảng tenant-scoped phải sao chép y nguyên từ đây:
 *   1. team_id là cột ĐẦU TIÊN + index dẫn đầu team_id
 *   2. UNIQUE(team_id, id) làm mỏ neo cho bảng con
 *   3. FK là COMPOSITE (team_id, parent_id) — không bao giờ FK cột đơn
 * Cộng thêm policy tenant_isolation (L2.5).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
// Xuôi DAG: authoring đọc dữ liệu identity qua FACADE, không chạm file nội bộ của module đó.
import { projects } from "../../identity/index.js";
// `appRole` là role DB của kernel — lấy từ facade kernel, cũng là cạnh xuôi DAG.
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const autCases = pgTable(
  "aut_cases",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    isStepGroup: boolean("is_step_group").notNull().default(false),
    prereqCaseId: uuid("prereq_case_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_cases_team_id_unique").on(t.teamId, t.id),
    index("aut_cases_team_project_idx").on(t.teamId, t.projectId),
    foreignKey({
      name: "aut_cases_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    // Self-FK composite: prereq KHÔNG BAO GIỜ trỏ được sang tenant khác.
    foreignKey({
      name: "aut_cases_prereq_fk",
      columns: [t.teamId, t.prereqCaseId],
      foreignColumns: [t.teamId, t.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
