import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  promoteCase,
  submitForReview,
} from "../../src/modules/authoring/review-service.js";
import {
  CaseStateError,
  FourEyesViolationError,
} from "../../src/modules/authoring/errors.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

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

/** Alice sửa, Alice submit, Bob duyệt. Trả về (caseId, version sau khi duyệt). */
async function approvedCase(): Promise<{ id: string; version: number }> {
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
  const submitted = await withTenant(t.db, ctx(), (tx) =>
    submitForReview(tx, ctx(), alice, { caseId: edited.id, expectedVersion: edited.version }),
  );
  const decided = await withTenant(t.db, ctx(), (tx) =>
    decideReview(tx, ctx(), bob, {
      caseId: edited.id,
      expectedVersion: submitted.version,
      decision: "approved",
    }),
  );
  return { id: decided.id, version: decided.version };
}

describe("promoteCase", () => {
  it("người KHÁC người sửa cuối promote được: status ready, ready_revision_id được ghim", async () => {
    const c = await approvedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
    expect(after.promotedAt).toBeDefined();
    expect(after.readyRevisionId).toBeDefined();
    expect(after.readyRevisionId).toBe(after.latestRevisionId);
  });

  it("FOUR-EYES: người sửa cuối tự promote ⇒ 403 FourEyesViolationError", async () => {
    const c = await approvedCase();
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FourEyesViolationError);
    expect((err as FourEyesViolationError).httpStatus).toBe(403);
  });

  it("teams.allow_self_promote = true ⇒ người sửa cuối tự promote ĐƯỢC", async () => {
    const c = await approvedCase();
    await t.db.execute(sql`UPDATE teams SET allow_self_promote = true WHERE id = ${teamId}`);
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
  });

  it("promote khi chưa được duyệt ⇒ CaseStateError", async () => {
    const created = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "C", isStepGroup: false }),
    );
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: created.id, expectedVersion: created.version }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: created.id, expectedVersion: submitted.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("promote khi review bị changes_requested ⇒ CaseStateError", async () => {
    const created = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "C", isStepGroup: false }),
    );
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: created.id, expectedVersion: created.version }),
    );
    const rejected = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: created.id,
        expectedVersion: submitted.version,
        decision: "changes_requested",
      }),
    );
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: created.id, expectedVersion: rejected.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });

  it("sửa case đã ready đưa về draft NHƯNG GIỮ ready_revision_id (lịch đêm vẫn chạy bản cũ)", async () => {
    const c = await approvedCase();
    const promoted = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    const edited = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: promoted.version,
        steps: [{ kind: "action", renderedSentence: "open login page v2", verbOpKey: "goto" }],
      }),
    );
    expect(edited.status).toBe("draft");
    expect(edited.readyRevisionId).toBe(promoted.readyRevisionId);
    expect(edited.latestRevisionId).not.toBe(promoted.readyRevisionId);
  });

  it("advisory lock NHẢ SẠCH sau khi transaction đóng — không rò khoá qua pool", async () => {
    const c = await approvedCase();
    await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    // pg_advisory_xact_lock tự nhả khi COMMIT (spike 2026-08-28). Nếu ai đó đổi sang
    // pg_advisory_lock (session-scope) thì test này ĐỎ ngay — đó là mục đích của nó.
    const after = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(after.rows[0]?.["n"]).toBe(0);
  });
});
