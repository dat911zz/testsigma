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
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
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

/** Máy trạng thái review: draft -> in_review -> ready. Không có đường tắt. */
export const autCaseStatus = pgEnum("aut_case_status", ["draft", "in_review", "ready"]);

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
    status: autCaseStatus("status").notNull().default("draft"),
    /** Optimistic concurrency: nguồn của ETag. Mọi mutation +1, không bao giờ lùi. */
    version: integer("version").notNull().default(1),
    /**
     * Ghim revision (blueprint §4 phase 1): schedule/CI compile bản `ready`,
     * ad-hoc của tác giả compile bản `latest`. FK composite được thêm ở Task 4
     * (bảng aut_case_revisions chưa tồn tại ở migration này).
     */
    latestRevisionId: uuid("latest_revision_id"),
    readyRevisionId: uuid("ready_revision_id"),
    /** Four-eyes so người promote với CHÍNH cột này. */
    lastEditedBy: uuid("last_edited_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedBy: uuid("promoted_by"),
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
    check("aut_cases_version_positive", sql`version > 0`),
    /**
     * Timeline không thể giả mạo: mỗi trạng thái đòi đúng bộ dấu thời gian của nó.
     * Hệ cũ để lọt case "ready" mà review_submitted_at chưa từng được ghi
     * (blueprint §8 #10) — CHECK này làm lớp lỗi đó không viết ra được.
     */
    check(
      "aut_cases_status_timeline",
      sql`(status = 'draft')
       OR (status = 'in_review' AND submitted_at IS NOT NULL)
       OR (status = 'ready' AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL
           AND promoted_at IS NOT NULL AND ready_revision_id IS NOT NULL)`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
