/**
 * Tầng test CONCURRENCY cho authoring — chỉ chạy trên Postgres THẬT (nhiều connection).
 *
 * VÌ SAO KHÔNG NẰM Ở TẦNG PGlite: `replaceSteps` là check-then-act cổ điển — đọc
 * `version`, so với `expectedVersion`, rồi mới ghi. PGlite chỉ có MỘT connection wasm
 * nên hai `withTenant` "song song" ở đó chỉ xếp hàng tuần tự: 8 test trong
 * `test/authoring/case-service.test.ts` đều `await` tuần tự và KHÔNG BAO GIỜ chạm được
 * cửa sổ giữa "đọc version" và "ghi". Bằng chứng chỉ tồn tại ở đây.
 *
 * Không có TESTKITE_TEST_PG_URL ⇒ cả suite skip (`bash scripts/test-pg.sh start` để
 * dựng cluster tạm). CI job postgres:17 luôn set biến ⇒ CI là nơi bằng chứng được thu.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import { VersionConflictError } from "../../src/modules/authoring/errors.js";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";

/** Cổng chặn: mở khi đủ `n` bên đã tới. Ép hai transaction cùng MỞ trước khi bên nào đọc. */
function makeGate(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= n) open();
    await opened;
  };
}

/** Chốt thủ công: `wait` chỉ đi tiếp sau khi ai đó gọi `signal`. */
function makeLatch(): { readonly signal: () => void; readonly wait: Promise<void> } {
  let signal: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { signal: () => signal(), wait };
}

describeRealPg("replaceSteps dưới tranh chấp THẬT (Postgres thật, hai connection)", () => {
  let r: RealDb;
  let teamId = "";
  let projectId = "";
  const alice = { userId: "" };
  const bob = { userId: "" };

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(sql`
      TRUNCATE aut_case_revisions, aut_rest_steps, aut_step_loops, aut_steps, aut_cases,
               memberships, projects, teams, users, organizations RESTART IDENTITY CASCADE`);
    const org = await r.db.execute(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const orgId = String(org.rows[0]?.["id"]);
    const team = await r.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
    );
    teamId = String(team.rows[0]?.["id"]);
    const p = await r.db.execute(
      sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`,
    );
    projectId = String(p.rows[0]?.["id"]);
    const u1 = await r.db.execute(
      sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`,
    );
    const u2 = await r.db.execute(
      sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`,
    );
    alice.userId = String(u1.rows[0]?.["id"]);
    bob.userId = String(u2.rows[0]?.["id"]);
  });

  const ctx = (): { teamId: string } => ({ teamId });

  const oneStep = (sentence: string): StepInputDto[] => [
    { kind: "action", renderedSentence: sentence, verbOpKey: "goto" },
  ];

  const seedCase = async (name: string): Promise<CaseSummaryDto> =>
    withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name, isStepGroup: false }),
    );

  it("hai edit song song cùng expectedVersion: một thắng, bên thua nhận VersionConflictError SẠCH (không phải lỗi DB thô)", async () => {
    const c = await seedCase("Checkout");
    const gate = makeGate(2);

    // Cả hai transaction đã BEGIN + SET LOCAL trước khi bên nào kịp đọc `version`.
    // Không có khoá, cả hai đọc trúng version=1 (chưa ai commit) nên CẢ HAI đi qua
    // nhánh so version rồi cùng chèn step ordinal=1 ⇒ bên thua ăn 23505 thô.
    const edit = (actor: { userId: string }, sentence: string): Promise<CaseSummaryDto> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return replaceSteps(tx, ctx(), actor, {
          caseId: c.id,
          expectedVersion: c.version,
          steps: oneStep(sentence),
        });
      });

    const results = await Promise.allSettled([
      edit(alice, "alice mở trang login"),
      edit(bob, "bob bấm banner cookie"),
    ]);
    const won = results.filter(
      (x): x is PromiseFulfilledResult<CaseSummaryDto> => x.status === "fulfilled",
    );
    const lost = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");

    expect(won.map((x) => x.value.version)).toEqual([2]);
    expect(lost.length).toBe(1);
    for (const l of lost) {
      const reason: unknown = l.reason;
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.code).toBe("version_conflict");
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(1);
      expect(conflict.diff.currentVersion).toBe(2);
    }

    // Bên thua rollback sạch: đúng một bộ step, đúng hai revision (#1 tạo + #2 của bên thắng).
    const steps = await r.db.execute(
      sql`SELECT rendered_sentence FROM aut_steps WHERE case_id = ${c.id} ORDER BY ordinal`,
    );
    expect(steps.rows.length).toBe(1);
    const revs = await r.db.execute(
      sql`SELECT case_version FROM aut_case_revisions WHERE case_id = ${c.id} ORDER BY revision_no`,
    );
    expect(revs.rows.map((x) => Number(x["case_version"]))).toEqual([1, 2]);
    const row = await r.db.execute(sql`SELECT version FROM aut_cases WHERE id = ${c.id}`);
    expect(Number(row.rows[0]?.["version"])).toBe(2);
  });

  it("khoá theo (team, case): edit case B KHÔNG bị transaction đang giữ khoá case A chặn", async () => {
    const a = await seedCase("Case A");
    const b = await seedCase("Case B");
    const locked = makeLatch();
    const release = makeLatch();

    const editA = withTenant(r.db, ctx(), async (tx) => {
      const summary = await replaceSteps(tx, ctx(), alice, {
        caseId: a.id,
        expectedVersion: a.version,
        steps: oneStep("A ghi xong, transaction VẪN MỞ nên khoá case A chưa nhả"),
      });
      locked.signal();
      await release.wait;
      return summary;
    });

    await locked.wait;
    // Khoá toàn cục (hoặc khoá bảng) sẽ treo ở đây tới khi test timeout.
    const summaryB = await withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), bob, {
        caseId: b.id,
        expectedVersion: b.version,
        steps: oneStep("B đi qua trong lúc A còn giữ khoá"),
      }),
    );
    expect(summaryB.version).toBe(2);

    release.signal();
    expect((await editA).version).toBe(2);
  });
});
