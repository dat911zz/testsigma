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
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
// Xuôi DAG: authoring đọc dữ liệu identity qua FACADE, không chạm file nội bộ của module đó.
import { projects } from "../../identity/index.js";
// `appRole` là role DB của kernel — lấy từ facade kernel, cũng là cạnh xuôi DAG.
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

/**
 * drizzle-orm 0.45.2 KHÔNG có kiểu `bytea` (kiểm chứng 2026-08-28) — tự khai.
 * fromDriver phải chịu được CẢ HAI driver: node-postgres trả Buffer, PGlite trả
 * Uint8Array. `Buffer.from` xử lý cả hai và luôn trả Buffer.
 */
export const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Buffer): Uint8Array {
    return value;
  },
  fromDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
});

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
  /**
   * Kiểu trả về ghi TƯỜNG MINH: hai FK dưới đây trỏ tới `autCaseRevisions` — bảng
   * khai SAU và tự nó lại trỏ ngược về `autCases`. Không có annotation này, suy
   * luận kiểu của TS đi vòng và ném TS7022/TS7024 ("implicitly has type any ...
   * referenced directly or indirectly in its own initializer").
   */
  (t): PgTableExtraConfigValue[] => [
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
    /**
     * Vòng FK hai chiều aut_cases ⇄ aut_case_revisions là hợp lệ: composite FK
     * sinh ra dạng ALTER TABLE ... ADD CONSTRAINT sau khi cả hai bảng đã tồn tại,
     * và thứ tự ghi lúc chạy là case trước (revision id NULL) → revision → UPDATE case.
     */
    foreignKey({
      name: "aut_cases_latest_revision_fk",
      columns: [t.teamId, t.latestRevisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
    }),
    foreignKey({
      name: "aut_cases_ready_revision_fk",
      columns: [t.teamId, t.readyRevisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
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

/**
 * 6 kind KHỚP CHÍNH XÁC `STEP_KINDS` của packages/contract/src/schemas/step.ts.
 * Lệch một nhãn là hợp đồng API nói dối về thứ DB chấp nhận.
 */
export const autStepKind = pgEnum("aut_step_kind", [
  "action",
  "step_group",
  "if",
  "for",
  "while",
  "rest",
]);

export const autSteps = pgTable(
  "aut_steps",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** if/for/while lồng cây: con trỏ về step cha, NULL = step gốc của case. */
    parentStepId: uuid("parent_step_id"),
    ordinal: integer("ordinal").notNull(),
    kind: autStepKind("kind").notNull(),
    renderedSentence: text("rendered_sentence").notNull(),
    /** kind=action */
    verbOpKey: text("verb_op_key"),
    /** kind=action — FK sang elm_elements thêm ở M4 (bảng chưa tồn tại). */
    elementId: uuid("element_id"),
    /** kind=action|rest — bản đồ chuỗi→chuỗi; secret đi dạng `$secret:<name>`. */
    args: jsonb("args"),
    /** kind=step_group — case có is_step_group = true. */
    stepGroupCaseId: uuid("step_group_case_id"),
    /** kind=if — ví dụ {SUCCESS}. */
    conditionExpected: text("condition_expected").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_steps_team_id_unique").on(t.teamId, t.id),
    /**
     * NULLS NOT DISTINCT: parent_step_id NULL nghĩa là "step gốc" — với ngữ nghĩa
     * NULL mặc định của Postgres thì hai step gốc cùng ordinal LỌT qua unique.
     * (drizzle 0.45.2 có .nullsNotDistinct() — đã kiểm chứng 2026-08-28.)
     */
    unique("aut_steps_position_unique")
      .on(t.teamId, t.caseId, t.parentStepId, t.ordinal)
      .nullsNotDistinct(),
    index("aut_steps_team_case_idx").on(t.teamId, t.caseId, t.ordinal),
    foreignKey({
      name: "aut_steps_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_steps_parent_fk",
      columns: [t.teamId, t.parentStepId],
      foreignColumns: [t.teamId, t.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_steps_step_group_fk",
      columns: [t.teamId, t.stepGroupCaseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }),
    check("aut_steps_ordinal_positive", sql`ordinal > 0`),
    /**
     * DB cưỡng chế union rẽ nhánh theo `kind` — đúng cái discriminatedUnion của
     * zod cưỡng chế ở biên API. Hai đầu cùng luật thì không có đường nào lọt.
     * for/while/rest KHÔNG có cột riêng ở đây: chi tiết nằm ở bảng 1:1.
     */
    check(
      "aut_steps_kind_shape",
      sql`(kind = 'action'     AND verb_op_key IS NOT NULL AND step_group_case_id IS NULL AND condition_expected IS NULL)
       OR (kind = 'step_group' AND step_group_case_id IS NOT NULL AND verb_op_key IS NULL AND element_id IS NULL AND args IS NULL AND condition_expected IS NULL)
       OR (kind = 'if'         AND condition_expected IS NOT NULL AND array_length(condition_expected, 1) >= 1 AND verb_op_key IS NULL AND step_group_case_id IS NULL AND element_id IS NULL)
       OR (kind IN ('for','while') AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL)
       OR (kind = 'rest'       AND verb_op_key IS NULL AND step_group_case_id IS NULL AND condition_expected IS NULL AND element_id IS NULL)`,
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

/**
 * 1:1 với step kind for/while — hậu duệ của `for_step_conditions` hệ cũ
 * (blueprint §2: engine loop THẬT, không phải 3 cột vestigial trên aut_steps).
 * FK sang tdt_profiles thêm ở M4.
 */
export const autStepLoops = pgTable(
  "aut_step_loops",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id").notNull(),
    dataProfileId: uuid("data_profile_id"),
    /** kind=while: NULL là dữ liệu hợp lệ — COMPILER phán (diagnostic while_without_max_iterations). */
    maxIterations: integer("max_iterations"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_step_loops_team_id_unique").on(t.teamId, t.id),
    unique("aut_step_loops_step_unique").on(t.teamId, t.stepId),
    index("aut_step_loops_team_idx").on(t.teamId, t.stepId),
    foreignKey({
      name: "aut_step_loops_step_fk",
      columns: [t.teamId, t.stepId],
      foreignColumns: [autSteps.teamId, autSteps.id],
    }).onDelete("cascade"),
    check("aut_step_loops_max_iterations_positive", sql`max_iterations IS NULL OR max_iterations > 0`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

/** 1:1 với step kind rest. */
export const autRestSteps = pgTable(
  "aut_rest_steps",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    headers: jsonb("headers"),
    body: text("body"),
    /** Tên biến hứng kết quả, ví dụ `orderId` → dùng lại bằng @{orderId}. */
    storeAs: text("store_as"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_rest_steps_team_id_unique").on(t.teamId, t.id),
    unique("aut_rest_steps_step_unique").on(t.teamId, t.stepId),
    index("aut_rest_steps_team_idx").on(t.teamId, t.stepId),
    foreignKey({
      name: "aut_rest_steps_step_fk",
      columns: [t.teamId, t.stepId],
      foreignColumns: [autSteps.teamId, autSteps.id],
    }).onDelete("cascade"),
    check(
      "aut_rest_steps_method_known",
      sql`method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')`,
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

/**
 * Ảnh chụp BẤT BIẾN của case. APPEND-ONLY: role app chỉ có GRANT SELECT + INSERT
 * (migration *_aut_case_revisions_grants.sql) — Postgres từ chối UPDATE/DELETE,
 * nên "lịch sử không sửa được" là một quyền, không phải một lời hứa.
 */
export const autCaseRevisions = pgTable(
  "aut_case_revisions",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** Đếm từ 1 trong phạm vi từng case. */
    revisionNo: integer("revision_no").notNull(),
    /**
     * Giá trị aut_cases.version TẠI thời điểm chụp. Đây là móc để dựng BASE của
     * diff 3 chiều: `If-Match: "7"` ⇒ tìm revision có case_version = 7.
     */
    caseVersion: integer("case_version").notNull(),
    codec: text("codec").notNull(),
    payload: bytea("payload").notNull(),
    /** Độ dài JSON canonical TRƯỚC nén. */
    payloadSize: integer("payload_size").notNull(),
    /** sha256 hex của JSON canonical (không phải của blob) — dedup + toàn vẹn. */
    payloadSha256: text("payload_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    note: text("note"),
  },
  (t) => [
    unique("aut_case_revisions_team_id_unique").on(t.teamId, t.id),
    unique("aut_case_revisions_no_unique").on(t.teamId, t.caseId, t.revisionNo),
    index("aut_case_revisions_case_version_idx").on(t.teamId, t.caseId, t.caseVersion),
    foreignKey({
      name: "aut_case_revisions_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    check("aut_case_revisions_codec_known", sql`codec IN ('zstd','raw')`),
    check("aut_case_revisions_no_positive", sql`revision_no > 0 AND case_version > 0`),
    check("aut_case_revisions_sha256_hex", sql`payload_sha256 ~ '^[0-9a-f]{64}$'`),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRole,
      using: tenantPredicate,
      withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
