/**
 * Module authoring — the FIRST asset table, built as the TEMPLATE for the ~50 tables
 * still to come. Three things every tenant-scoped table must copy verbatim from here:
 *   1. team_id is the FIRST column + a leading team_id index
 *   2. UNIQUE(team_id, id) serves as the anchor for child tables
 *   3. FKs are COMPOSITE (team_id, parent_id) — never a single-column FK
 * Plus the tenant_isolation policy (L2.5).
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
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
// Forward along the DAG: authoring reads identity data through the FACADE, never touching that module's internal files.
import { projects } from "../../identity/index.js";
// `appRole` is kernel's DB role — pulled from the kernel facade, also a forward DAG edge.
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

/**
 * drizzle-orm 0.45.2 does NOT have a `bytea` type (verified 2026-08-28) — declared by hand.
 * fromDriver must tolerate BOTH drivers: node-postgres returns a Buffer, PGlite returns
 * a Uint8Array. `Buffer.from` handles both and always returns a Buffer.
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

/** Review state machine: draft -> in_review -> ready. No shortcuts. */
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
    /** Optimistic concurrency: the source of the ETag. Every mutation +1, never goes backward. */
    version: integer("version").notNull().default(1),
    /**
     * Revision pin (blueprint §4 phase 1): schedule/CI compiles the `ready` version,
     * the author's ad-hoc runs compile `latest`. The composite FK is added in Task 4
     * (the aut_case_revisions table doesn't exist yet at this migration).
     */
    latestRevisionId: uuid("latest_revision_id"),
    readyRevisionId: uuid("ready_revision_id"),
    /** Four-eyes compares the promoter against THIS EXACT column. */
    lastEditedBy: uuid("last_edited_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedBy: uuid("promoted_by"),
  },
  /**
   * Return type spelled out EXPLICITLY: the two FKs below point to `autCaseRevisions` — a
   * table declared LATER that itself points back to `autCases`. Without this annotation,
   * TS's type inference goes in a circle and throws TS7022/TS7024 ("implicitly has type any ...
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
    // Self-FK composite: a prereq can NEVER point at another tenant.
    foreignKey({
      name: "aut_cases_prereq_fk",
      columns: [t.teamId, t.prereqCaseId],
      foreignColumns: [t.teamId, t.id],
    }),
    check("aut_cases_version_positive", sql`version > 0`),
    /**
     * The timeline can't be forged: each status requires exactly its own set of
     * timestamps. The legacy system let a "ready" case slip through with
     * review_submitted_at never written (blueprint §8 #10) — this CHECK makes that
     * class of bug unwritable.
     */
    check(
      "aut_cases_status_timeline",
      sql`(status = 'draft')
       OR (status = 'in_review' AND submitted_at IS NOT NULL)
       OR (status = 'ready' AND submitted_at IS NOT NULL AND reviewed_at IS NOT NULL
           AND promoted_at IS NOT NULL AND ready_revision_id IS NOT NULL)`,
    ),
    /**
     * The bidirectional FK cycle aut_cases ⇄ aut_case_revisions is valid: the composite
     * FK generates an ALTER TABLE ... ADD CONSTRAINT that runs after both tables already
     * exist, and the runtime write order is case first (revision id NULL) → revision → UPDATE case.
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
 * 6 kinds that MATCH EXACTLY the `STEP_KINDS` in packages/contract/src/schemas/step.ts.
 * One label off and the API contract lies about what the DB accepts.
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
    /** if/for/while nest as a tree: points back at the parent step, NULL = the case's root step. */
    parentStepId: uuid("parent_step_id"),
    ordinal: integer("ordinal").notNull(),
    kind: autStepKind("kind").notNull(),
    renderedSentence: text("rendered_sentence").notNull(),
    /** kind=action */
    verbOpKey: text("verb_op_key"),
    /** kind=action — FK to elm_elements added in M4 (table doesn't exist yet). */
    elementId: uuid("element_id"),
    /** kind=action|rest — a string→string map; secrets go as `$secret:<name>`. */
    args: jsonb("args"),
    /** kind=step_group — a case with is_step_group = true. */
    stepGroupCaseId: uuid("step_group_case_id"),
    /** kind=if — e.g. {SUCCESS}. */
    conditionExpected: text("condition_expected").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("aut_steps_team_id_unique").on(t.teamId, t.id),
    /**
     * NULLS NOT DISTINCT: parent_step_id NULL means "root step" — with Postgres's default
     * NULL semantics, two root steps sharing the same ordinal would SLIP past unique.
     * (drizzle 0.45.2 has .nullsNotDistinct() — verified 2026-08-28.)
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
    // Deliberately NO .onDelete("cascade") here, unlike its two sibling FKs above: a case
    // being deleted may still be referenced as the step_group of a step_group step living
    // in a DIFFERENT case. Cascading would silently gut that other case's steps; the
    // default NO ACTION instead blocks the delete so the conflict surfaces loudly.
    foreignKey({
      name: "aut_steps_step_group_fk",
      columns: [t.teamId, t.stepGroupCaseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }),
    check("aut_steps_ordinal_positive", sql`ordinal > 0`),
    /**
     * The DB enforces the union branching on `kind` — the exact same thing zod's
     * discriminatedUnion enforces at the API boundary. Both ends sharing one rule leaves
     * no path through. for/while/rest have NO dedicated columns here: their details live
     * in the 1:1 tables.
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
 * 1:1 with step kind for/while — the successor to the legacy system's
 * `for_step_conditions` (blueprint §2: a REAL loop engine, not 3 vestigial columns
 * on aut_steps). FK to tdt_profiles added in M4.
 */
export const autStepLoops = pgTable(
  "aut_step_loops",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    stepId: uuid("step_id").notNull(),
    dataProfileId: uuid("data_profile_id"),
    /** kind=while: NULL is valid data — the COMPILER is the judge (diagnostic while_without_max_iterations). */
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

/** 1:1 with step kind rest. */
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
    /** Name of the variable that captures the result, e.g. `orderId` → reused via @{orderId}. */
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
 * An IMMUTABLE snapshot of a case. APPEND-ONLY: the app role only has GRANT SELECT + INSERT
 * (migration *_aut_case_revisions_grants.sql) — Postgres refuses UPDATE/DELETE,
 * so "history can't be edited" is a permission, not a promise.
 */
export const autCaseRevisions = pgTable(
  "aut_case_revisions",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** Counts from 1 within each case. */
    revisionNo: integer("revision_no").notNull(),
    /**
     * The value of aut_cases.version AT the moment of the snapshot. This is the hook used
     * to build the BASE of the three-way diff: `If-Match: "7"` ⇒ find the revision with case_version = 7.
     */
    caseVersion: integer("case_version").notNull(),
    codec: text("codec").notNull(),
    payload: bytea("payload").notNull(),
    /** Length of the canonical JSON BEFORE compression. */
    payloadSize: integer("payload_size").notNull(),
    /** sha256 hex of the canonical JSON (not of the blob) — dedup + integrity. */
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

export const autReviewState = pgEnum("aut_review_state", [
  "open",
  "approved",
  "changes_requested",
  "withdrawn",
]);

/**
 * Review record, one row per time a case is put up for review. History is kept (old
 * rows are never deleted) so the UI can see how many times a case was sent back for changes.
 */
export const autCaseReviews = pgTable(
  "aut_case_reviews",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    /** The SPECIFIC version put up for review — reviewing a version, not reviewing "the case". */
    revisionId: uuid("revision_id").notNull(),
    state: autReviewState("state").notNull().default("open"),
    requestedBy: uuid("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
  },
  (t) => [
    unique("aut_case_reviews_team_id_unique").on(t.teamId, t.id),
    index("aut_case_reviews_case_idx").on(t.teamId, t.caseId, t.requestedAt),
    /**
     * At most ONE open review per case — enforced at the DB, not the service, because
     * two concurrent submit requests would both read "no review yet" and both write.
     * A partial index (WHERE state='open') is the only way to express "conditional
     * unique" in Postgres. Verified running on PGlite 18.3 (spike 2026-08-28).
     */
    uniqueIndex("aut_case_reviews_one_open")
      .on(t.teamId, t.caseId)
      .where(sql`state = 'open'`),
    foreignKey({
      name: "aut_case_reviews_case_fk",
      columns: [t.teamId, t.caseId],
      foreignColumns: [autCases.teamId, autCases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "aut_case_reviews_revision_fk",
      columns: [t.teamId, t.revisionId],
      foreignColumns: [autCaseRevisions.teamId, autCaseRevisions.id],
    }),
    check(
      "aut_case_reviews_decided_shape",
      sql`(state = 'open' AND decided_by IS NULL AND decided_at IS NULL)
       OR (state <> 'open' AND decided_at IS NOT NULL)`,
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
