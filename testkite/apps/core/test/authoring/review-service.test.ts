import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  submitForReview,
  withdrawReview,
} from "../../src/modules/authoring/review-service.js";
import { CaseStateError, VersionConflictError } from "../../src/modules/authoring/errors.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

/**
 * drizzle-orm 0.45 BỌC lỗi driver: `message` chỉ là "Failed query: <sql>\nparams: …"
 * nên `rejects.toThrow(/duplicate key|unique/i)` KHÔNG BAO GIỜ xanh (đã dựng lại:
 * message không chứa chữ nào trong hai chữ đó). Khẳng định thẳng vào `cause` —
 * đúng pattern đã chốt ở M1 (test/schema/tenancy.test.ts) và T3 (step-schema.test.ts),
 * và chặt hơn regex: nó chỉ đích danh `aut_case_reviews_one_open` chứ không nhận
 * nhầm một unique khác.
 */
type PgFailure = { readonly code?: string; readonly constraint?: string };

async function violationOf(p: PromiseLike<unknown>): Promise<PgFailure | undefined> {
  const err: unknown = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { readonly cause?: PgFailure } | undefined)?.cause;
}

/** SQLSTATE 23505 unique_violation. */
const UNIQUE_VIOLATION = "23505";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(
    sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
  );
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
  );
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(
    sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`,
  );
  const u2 = await t.db.execute(
    sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`,
  );
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

async function seedDraftWithSteps(): Promise<{ id: string; version: number }> {
  const created = await withTenant(t.db, ctx(), (tx) =>
    createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
  );
  const edited = await withTenant(t.db, ctx(), (tx) =>
    replaceSteps(tx, ctx(), alice, {
      caseId: created.id,
      expectedVersion: created.version,
      steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
    }),
  );
  return { id: edited.id, version: edited.version };
}

describe("aut_case_reviews — hình dạng", () => {
  it("enum aut_review_state đúng 4 trạng thái", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'aut_review_state' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual([
      "open",
      "approved",
      "changes_requested",
      "withdrawn",
    ]);
  });

  it("partial unique index chặn HAI review open trên cùng case", async () => {
    const c = await seedDraftWithSteps();
    const revId = await t.db.execute(
      sql`SELECT latest_revision_id AS r FROM aut_cases WHERE id = ${c.id}`,
    );
    const revisionId = String(revId.rows[0]?.["r"]);
    const ins = sql`
      INSERT INTO aut_case_reviews (team_id, case_id, revision_id, state, requested_by)
      VALUES (${teamId},${c.id},${revisionId},'open',${alice.userId})`;
    await t.db.execute(ins);
    const cause = await violationOf(t.db.execute(ins));
    expect(cause?.code).toBe(UNIQUE_VIOLATION);
    expect(cause?.constraint).toBe("aut_case_reviews_one_open");
  });

  it("hai review ĐÃ ĐÓNG trên cùng case thì được — index chỉ ràng buộc state='open'", async () => {
    const c = await seedDraftWithSteps();
    const revId = await t.db.execute(
      sql`SELECT latest_revision_id AS r FROM aut_cases WHERE id = ${c.id}`,
    );
    const revisionId = String(revId.rows[0]?.["r"]);
    for (const state of ["approved", "changes_requested"]) {
      await t.db.execute(sql`
        INSERT INTO aut_case_reviews (team_id, case_id, revision_id, state, requested_by, decided_by, decided_at)
        VALUES (${teamId},${c.id},${revisionId},${state},${alice.userId},${bob.userId},now())`);
    }
    const r = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(r.rows[0]?.["n"]).toBe(2);
  });
});

describe("submitForReview", () => {
  it("draft -> in_review, đóng dấu submitted_at/submitted_by, mở review, bump version", async () => {
    const c = await seedDraftWithSteps();
    const after = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("in_review");
    expect(after.submittedAt).toBeDefined();
    expect(after.version).toBe(c.version + 1);

    const r = await t.db.execute(sql`
      SELECT state, requested_by FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.["state"]).toBe("open");
    expect(r.rows[0]?.["requested_by"]).toBe(alice.userId);
  });

  it("submit lần hai khi đang in_review ⇒ CaseStateError", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: s.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("version lệch ⇒ VersionConflictError, mine RỖNG (submit không gửi payload)", async () => {
    const c = await seedDraftWithSteps();
    const err = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version - 1 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).diff.mine).toEqual([]);
    expect((err as VersionConflictError).diff.currentVersion).toBe(c.version);
  });
});

describe("decideReview", () => {
  it("approved: đóng dấu reviewed_at/reviewed_by, GIỮ status in_review (promote là bước riêng)", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId: c.id, expectedVersion: s.version, decision: "approved" }),
    );
    expect(after.status).toBe("in_review");
    expect(after.reviewedAt).toBeDefined();
    const r = await t.db.execute(
      sql`SELECT state, decided_by FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(r.rows[0]?.["state"]).toBe("approved");
    expect(r.rows[0]?.["decided_by"]).toBe(bob.userId);
  });

  it("changes_requested: quay về draft, review đóng, comment được lưu", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: s.version,
        decision: "changes_requested",
        comment: "thiếu bước xác nhận đơn",
      }),
    );
    expect(after.status).toBe("draft");
    const r = await t.db.execute(
      sql`SELECT state, comment FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(r.rows[0]?.["state"]).toBe("changes_requested");
    expect(r.rows[0]?.["comment"]).toBe("thiếu bước xác nhận đơn");
  });

  it("decide khi case đang draft (không có review mở) ⇒ CaseStateError", async () => {
    const c = await seedDraftWithSteps();
    const err = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version, decision: "approved" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });
});

describe("withdrawReview", () => {
  it("in_review -> draft và review chuyển withdrawn, mở đường sửa tiếp", async () => {
    const c = await seedDraftWithSteps();
    const s = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const after = await withTenant(t.db, ctx(), (tx) =>
      withdrawReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: s.version }),
    );
    expect(after.status).toBe("draft");
    const r = await t.db.execute(sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`);
    expect(r.rows[0]?.["state"]).toBe("withdrawn");
    // và sau khi rút thì sửa được ngay (Task 9 chặn khi in_review)
    const edited = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: after.version,
        steps: [{ kind: "action", renderedSentence: "open login page v2", verbOpKey: "goto" }],
      }),
    );
    expect(edited.version).toBe(after.version + 1);
  });
});
