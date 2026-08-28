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

/** Alice edits, Alice submits, Bob approves. Returns (caseId, version after approval). */
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
  it("someone OTHER than the last editor can promote: status ready, ready_revision_id is pinned", async () => {
    const c = await approvedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
    expect(after.promotedAt).toBeDefined();
    expect(after.readyRevisionId).toBeDefined();
    expect(after.readyRevisionId).toBe(after.latestRevisionId);
  });

  it("FOUR-EYES: the last editor self-promoting ⇒ 403 FourEyesViolationError", async () => {
    const c = await approvedCase();
    const err = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FourEyesViolationError);
    expect((err as FourEyesViolationError).httpStatus).toBe(403);
  });

  it("teams.allow_self_promote = true ⇒ the last editor CAN self-promote", async () => {
    const c = await approvedCase();
    await t.db.execute(sql`UPDATE teams SET allow_self_promote = true WHERE id = ${teamId}`);
    const after = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    expect(after.status).toBe("ready");
  });

  it("promoting before it's been approved ⇒ CaseStateError", async () => {
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

  it("promoting when the review was changes_requested ⇒ CaseStateError", async () => {
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

  it("editing a ready case sends it to draft BUT KEEPS ready_revision_id (the nightly schedule still runs the old version)", async () => {
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

  it("the advisory lock is FULLY RELEASED after the transaction closes — no lock leaks through the pool", async () => {
    const c = await approvedCase();
    await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version }),
    );
    // pg_advisory_xact_lock releases automatically on COMMIT (spike 2026-08-28). If someone
    // switches to pg_advisory_lock (session-scope), this test goes RED immediately — that's its purpose.
    const after = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(after.rows[0]?.["n"]).toBe(0);
  });
});
