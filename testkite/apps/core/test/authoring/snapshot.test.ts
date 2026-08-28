import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { DataProfileDto, ElementDto, EnvDto } from "@testkite/contract";
import { compileSnapshotSchema } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { decideReview, promoteCase, submitForReview } from "../../src/modules/authoring/review-service.js";
import { buildCompileSnapshot } from "../../src/modules/authoring/snapshot.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };

const ENV: EnvDto = { baseUrl: "https://app.test", vars: { locale: "vi" }, secretNames: ["std_user_password"] };
const DEPS = {
  loadElements: async (): Promise<Record<string, ElementDto>> => ({}),
  loadDataProfiles: async (): Promise<Record<string, DataProfileDto>> => ({}),
  env: ENV,
};

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
});

const ctx = (): { teamId: string } => ({ teamId });

async function caseWithSteps(name: string, prereqCaseId?: string): Promise<string> {
  const created = await withTenant(t.db, ctx(), (tx) =>
    createCase(tx, ctx(), alice, {
      projectId,
      name,
      isStepGroup: false,
      ...(prereqCaseId === undefined ? {} : { prereqCaseId }),
    }),
  );
  await withTenant(t.db, ctx(), (tx) =>
    replaceSteps(tx, ctx(), alice, {
      caseId: created.id,
      expectedVersion: created.version,
      steps: [
        { kind: "action", renderedSentence: `${name}: open page`, verbOpKey: "goto" },
        {
          kind: "if",
          renderedSentence: `${name}: if ok`,
          conditionExpected: ["SUCCESS"],
          children: [{ kind: "action", renderedSentence: `${name}: click`, verbOpKey: "click" }],
        },
      ],
    }),
  );
  return created.id;
}

describe("buildCompileSnapshot", () => {
  it("sinh snapshot THOẢ compileSnapshotSchema của contract", async () => {
    const caseId = await caseWithSteps("Checkout");
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    expect(compileSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.teamId).toBe(teamId);
    expect(snap.projectId).toBe(projectId);
    expect(snap.targetCaseIds).toEqual([caseId]);
  });

  it("dựng lại CÂY step từ payload phẳng: `if` có children đúng, ordinal đánh lại từ 1", async () => {
    const caseId = await caseWithSteps("Checkout");
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    const steps = snap.cases[caseId]?.steps ?? [];
    expect(steps.map((s) => [s.ordinal, s.kind])).toEqual([
      [1, "action"],
      [2, "if"],
    ]);
    const branch = steps[1];
    expect(branch?.kind === "if" ? branch.children.map((c) => [c.ordinal, c.kind]) : []).toEqual([[1, "action"]]);
  });

  it("đóng bao chuỗi prereq — case phụ thuộc có mặt trong `cases` dù không nằm trong target", async () => {
    const loginId = await caseWithSteps("Login");
    const checkoutId = await caseWithSteps("Checkout", loginId);
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [checkoutId], pin: "latest" }, DEPS),
    );
    expect(Object.keys(snap.cases).sort()).toEqual([checkoutId, loginId].sort());
    expect(snap.cases[checkoutId]?.prereqCaseId).toBe(loginId);
    expect(snap.targetCaseIds).toEqual([checkoutId]);
  });

  it("pin='ready' đọc BẢN ĐÃ PROMOTE, không phải bản nháp đang sửa", async () => {
    const caseId = await caseWithSteps("Checkout");
    const cur = await t.db.execute(sql`SELECT version FROM aut_cases WHERE id = ${caseId}`);
    const v = Number(cur.rows[0]?.["version"]);
    const submitted = await withTenant(t.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId, expectedVersion: v }),
    );
    const decided = await withTenant(t.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, { caseId, expectedVersion: submitted.version, decision: "approved" }),
    );
    const promoted = await withTenant(t.db, ctx(), (tx) =>
      promoteCase(tx, ctx(), bob, { caseId, expectedVersion: decided.version }),
    );
    // Sau khi promote, Alice sửa tiếp — bản 'ready' KHÔNG được đổi theo.
    await withTenant(t.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId,
        expectedVersion: promoted.version,
        steps: [{ kind: "action", renderedSentence: "BẢN NHÁP MỚI", verbOpKey: "goto" }],
      }),
    );

    const ready = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "ready" }, DEPS),
    );
    const latest = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "latest" }, DEPS),
    );
    expect(ready.cases[caseId]?.steps.map((s) => s.renderedSentence)).toEqual([
      "Checkout: open page",
      "Checkout: if ok",
    ]);
    expect(latest.cases[caseId]?.steps.map((s) => s.renderedSentence)).toEqual(["BẢN NHÁP MỚI"]);
    expect(ready.cases[caseId]?.revisionId).not.toBe(latest.cases[caseId]?.revisionId);
  });

  it("pin='ready' trên case CHƯA từng promote ⇒ ném lỗi rõ ràng, không âm thầm lấy latest", async () => {
    const caseId = await caseWithSteps("Checkout");
    await expect(
      withTenant(t.db, ctx(), (tx) =>
        buildCompileSnapshot(tx, ctx(), { projectId, targetCaseIds: [caseId], pin: "ready" }, DEPS),
      ),
    ).rejects.toThrow(/chưa có bản ready|ready/i);
  });

  it("gom element id + data profile id rồi gọi ĐÚNG MỘT lần cho mỗi cổng", async () => {
    const caseId = await caseWithSteps("Checkout");
    const calls = { elements: 0, profiles: 0 };
    const snap = await withTenant(t.db, ctx(), (tx) =>
      buildCompileSnapshot(
        tx,
        ctx(),
        { projectId, targetCaseIds: [caseId], pin: "latest" },
        {
          loadElements: async (ids) => {
            calls.elements += 1;
            return Object.fromEntries(
              ids.map((id) => [id, { id, name: id, status: "pending_locator", locators: [] } as const]),
            );
          },
          loadDataProfiles: async () => {
            calls.profiles += 1;
            return {};
          },
          env: ENV,
        },
      ),
    );
    expect(calls).toEqual({ elements: 1, profiles: 1 });
    expect(snap.env).toEqual(ENV);
  });

  it("case của tenant khác trong targetCaseIds ⇒ CaseNotFoundError (404), không rò rỉ", async () => {
    const caseId = await caseWithSteps("Checkout");
    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    const otherTeamId = String(other.rows[0]?.["id"]);
    const err = await withTenant(t.db, { teamId: otherTeamId }, (tx) =>
      buildCompileSnapshot(
        tx,
        { teamId: otherTeamId },
        { projectId, targetCaseIds: [caseId], pin: "latest" },
        DEPS,
      ),
    ).catch((e: unknown) => e);
    expect((err as { httpStatus?: number }).httpStatus).toBe(404);
  });
});
