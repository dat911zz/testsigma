import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { RevisionRepo } from "../../src/modules/authoring/db/revision-repo.js";
import { CaseStateError, VersionConflictError } from "../../src/modules/authoring/errors.js";
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

const TWO_STEPS: StepInputDto[] = [
  { kind: "action", renderedSentence: "open login page", verbOpKey: "goto" },
  { kind: "action", renderedSentence: "type username", verbOpKey: "type", args: { value: "qa" } },
];

describe("createCase", () => {
  it("creates a draft case at version 1 and writes revision #1 immediately", async () => {
    const summary = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    expect(summary.status).toBe("draft");
    expect(summary.version).toBe(1);
    expect(summary.latestRevisionId).toBeDefined();
    expect(summary.readyRevisionId).toBeUndefined();
    expect(summary.lastEditedBy).toBe(alice.userId);

    const r = await t.db.execute(sql`
      SELECT revision_no, case_version, codec FROM aut_case_revisions WHERE case_id = ${summary.id}`);
    expect(r.rows.length).toBe(1);
    expect(Number(r.rows[0]?.["revision_no"])).toBe(1);
    expect(Number(r.rows[0]?.["case_version"])).toBe(1);
  });
});

describe("replaceSteps", () => {
  async function seedCase(): Promise<{ id: string; version: number }> {
    const s = await withTenant(t.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    return { id: s.id, version: s.version };
  }

  it("writes steps, bumps version, writes a new revision, updates last_edited_by", async () => {
    const c = await seedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    expect(after.version).toBe(2);
    expect(after.lastEditedBy).toBe(bob.userId);

    const steps = await t.db.execute(sql`
      SELECT ordinal, kind, rendered_sentence FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`);
    expect(steps.rows.map((x) => x["rendered_sentence"])).toEqual([
      "open login page",
      "type username",
    ]);

    const revs = await t.db.execute(sql`
      SELECT revision_no, case_version FROM aut_case_revisions WHERE case_id = ${c.id} ORDER BY revision_no`);
    expect(revs.rows.map((x) => Number(x["case_version"]))).toEqual([1, 2]);
  });

  it("the revision payload decompresses to exactly the step tree just written", async () => {
    const c = await seedCase();
    const after = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    const payload = await withTenant(t.db, ctx(), async (tx) => {
      const repo = new RevisionRepo(tx, ctx());
      return repo.loadPayload(after.latestRevisionId ?? "");
    });
    expect(payload.steps.map((s) => s.renderedSentence)).toEqual([
      "open login page",
      "type username",
    ]);
    expect(payload.steps[0]?.after).toBeNull();
    expect(payload.steps[1]?.after).toBe(payload.steps[0]?.id);
  });

  it("keeps the id of a step the client echoes back — step identity survives across multiple saves", async () => {
    const c = await seedCase();
    const v2 = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version, steps: TWO_STEPS }),
    );
    const ids = await t.db.execute(
      sql`SELECT id FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`,
    );
    const firstId = String(ids.rows[0]?.["id"]);
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: v2.version,
        steps: [
          { id: firstId, kind: "action", renderedSentence: "open login page (v2)", verbOpKey: "goto" },
          ...TWO_STEPS.slice(1),
        ],
      }),
    );
    const after = await t.db.execute(
      sql`SELECT id FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`,
    );
    expect(String(after.rows[0]?.["id"])).toBe(firstId);
  });

  it("version mismatch ⇒ VersionConflictError carries the correct three-way diff", async () => {
    const c = await seedCase();
    // Alice saves first, pushing the server to version 2.
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    );
    // Bob is still holding version 1 and saves a different version.
    const err = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: 1,
        steps: [{ kind: "action", renderedSentence: "accept cookie banner", verbOpKey: "click" }],
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VersionConflictError);
    const conflict = err as VersionConflictError;
    expect(conflict.httpStatus).toBe(409);
    expect(conflict.diff.baseVersion).toBe(1);
    expect(conflict.diff.currentVersion).toBe(2);
    expect(conflict.diff.mine.length).toBeGreaterThan(0);
    expect(conflict.diff.theirs.length).toBeGreaterThan(0);
  });

  it("writes NOTHING on conflict — the revision count doesn't increase", async () => {
    const c = await seedCase();
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    );
    const before = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM aut_case_revisions WHERE case_id = ${c.id}`,
    );
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    ).catch(() => undefined);
    const after = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM aut_case_revisions WHERE case_id = ${c.id}`,
    );
    expect(after.rows[0]?.["n"]).toBe(before.rows[0]?.["n"]);
  });

  it("a case belonging to another tenant ⇒ CaseNotFoundError (404), NOT 403", async () => {
    const c = await seedCase();
    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    const otherTeamId = String(other.rows[0]?.["id"]);
    const err = await withTenant(t.db, { teamId: otherTeamId }, (tx) =>
      replaceSteps(tx, { teamId: otherTeamId }, alice, {
        caseId: c.id,
        expectedVersion: 1,
        steps: TWO_STEPS,
      }),
    ).catch((e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(404);
  });

  it("editing a case that is in_review ⇒ CaseStateError", async () => {
    const c = await seedCase();
    await t.db.execute(sql`
      UPDATE aut_cases SET status='in_review', submitted_at=now(), submitted_by=${alice.userId}
      WHERE id = ${c.id}`);
    const err = await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, { caseId: c.id, expectedVersion: 1, steps: TWO_STEPS }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseStateError);
  });
});
