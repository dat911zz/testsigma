/**
 * Tầng test CONCURRENCY cho MÁY TRẠNG THÁI REVIEW — chỉ chạy trên Postgres THẬT.
 *
 * VÌ SAO KHÔNG NẰM Ở TẦNG PGlite: `submitForReview` / `withdrawReview` / `decideReview`
 * đều đi qua `loadForMutation` — đọc `version`, so với `expectedVersion`, rồi mới ghi:
 * check-then-act y hệt `replaceSteps` (xem case-edit-race.test.ts). PGlite chỉ có MỘT
 * connection wasm nên hai `withTenant` "song song" ở đó xếp hàng tuần tự và không bao
 * giờ chạm được cửa sổ giữa "đọc version" và "ghi". Bằng chứng chỉ tồn tại ở đây.
 *
 * Hai hỏng hóc được dựng lại (đo thật trước khi vá):
 *  1. `decide('approved')` song song `withdraw` cùng `expectedVersion` ⇒ CẢ HAI trả
 *     thành công, DB chỉ giữ được một quyết định — LOST UPDATE IM LẶNG: response của
 *     bên thua mô tả một trạng thái không tồn tại trong DB.
 *  2. Hai `submitForReview` song song ⇒ bên thua đâm vào unique (revision_no /
 *     `aut_case_reviews_one_open`) và ném DrizzleQueryError/23505 THÔ thay vì hợp đồng
 *     409 `VersionConflictError`.
 *
 * Không có TESTKITE_TEST_PG_URL ⇒ cả suite skip (`bash scripts/test-pg.sh start` để
 * dựng cluster tạm). CI job postgres:17 luôn set biến ⇒ CI là nơi bằng chứng được thu.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { CaseSummaryDto, StepInputDto } from "@testkite/contract";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  submitForReview,
  withdrawReview,
} from "../../src/modules/authoring/review-service.js";
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

/** Tách hai nhánh của `Promise.allSettled` mà không cần `!` hay cast. */
function splitResults(results: readonly PromiseSettledResult<CaseSummaryDto>[]): {
  readonly won: readonly CaseSummaryDto[];
  readonly lost: readonly unknown[];
} {
  const won: CaseSummaryDto[] = [];
  const lost: unknown[] = [];
  for (const res of results) {
    if (res.status === "fulfilled") won.push(res.value);
    else lost.push(res.reason);
  }
  return { won, lost };
}

function onlyWinner(won: readonly CaseSummaryDto[]): CaseSummaryDto {
  const [first] = won;
  if (first === undefined) throw new Error("không có bên nào thắng — cả hai đều hỏng");
  return first;
}

describeRealPg("máy trạng thái review dưới tranh chấp THẬT (Postgres thật, hai connection)", () => {
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
      TRUNCATE aut_case_reviews, aut_case_revisions, aut_rest_steps, aut_step_loops, aut_steps,
               aut_cases, memberships, projects, teams, users, organizations RESTART IDENTITY CASCADE`);
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

  /** Case draft đã có step (submit đòi case có revision thật). */
  const seedDraftWithSteps = async (): Promise<CaseSummaryDto> => {
    const created = await withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    return withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: created.id,
        expectedVersion: created.version,
        steps: oneStep("open login page"),
      }),
    );
  };

  const caseRowOf = async (caseId: string): Promise<{ version: number; status: string }> => {
    const row = await r.db.execute(
      sql`SELECT version, status FROM aut_cases WHERE id = ${caseId}`,
    );
    return {
      version: Number(row.rows[0]?.["version"]),
      status: String(row.rows[0]?.["status"]),
    };
  };

  it("hai submit song song cùng expectedVersion: một thắng, bên thua nhận 409 SẠCH (không phải 23505 thô)", async () => {
    const c = await seedDraftWithSteps();
    const gate = makeGate(2);

    const submit = (actor: { userId: string }): Promise<CaseSummaryDto> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return submitForReview(tx, ctx(), actor, { caseId: c.id, expectedVersion: c.version });
      });

    const { won, lost } = splitResults(await Promise.allSettled([submit(alice), submit(bob)]));

    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const winner = onlyWinner(won);
    expect(winner.status).toBe("in_review");
    expect(winner.version).toBe(c.version + 1);
    for (const reason of lost) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.code).toBe("version_conflict");
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(c.version);
      expect(conflict.diff.currentVersion).toBe(c.version + 1);
      // submit không gửi payload nên nhánh "mine" rỗng (hợp đồng conflictFor).
      expect(conflict.diff.mine).toEqual([]);
    }

    // Bên thua rollback sạch: đúng MỘT review đang mở, DB khớp response bên thắng.
    const reviews = await r.db.execute(
      sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(reviews.rows.map((x) => x["state"])).toEqual(["open"]);
    expect(await caseRowOf(c.id)).toEqual({ version: winner.version, status: winner.status });
  });

  it("decide(approved) song song withdraw cùng expectedVersion: KHÔNG lost update — bên thua nhận 409, DB khớp bên thắng", async () => {
    const c = await seedDraftWithSteps();
    const submitted = await withTenant(r.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: c.id, expectedVersion: c.version }),
    );
    const gate = makeGate(2);

    const decide = withTenant(r.db, ctx(), async (tx) => {
      await gate();
      return decideReview(tx, ctx(), bob, {
        caseId: c.id,
        expectedVersion: submitted.version,
        decision: "approved",
      });
    });
    const withdraw = withTenant(r.db, ctx(), async (tx) => {
      await gate();
      return withdrawReview(tx, ctx(), alice, {
        caseId: c.id,
        expectedVersion: submitted.version,
      });
    });

    const { won, lost } = splitResults(await Promise.allSettled([decide, withdraw]));

    // Hỏng hóc phải chết ở đây: KHÔNG khoá thì cả hai đều "thành công" và DB chỉ giữ
    // được một quyết định — bên thua nhận về một trạng thái không có thật.
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const winner = onlyWinner(won);
    expect(winner.version).toBe(submitted.version + 1);
    for (const reason of lost) {
      expect(reason).toBeInstanceOf(VersionConflictError);
      const conflict = reason as VersionConflictError;
      expect(conflict.httpStatus).toBe(409);
      expect(conflict.diff.baseVersion).toBe(submitted.version);
      expect(conflict.diff.currentVersion).toBe(submitted.version + 1);
    }

    // DB khớp ĐÚNG response bên thắng: approve giữ in_review, withdraw đưa về draft.
    const reviews = await r.db.execute(
      sql`SELECT state FROM aut_case_reviews WHERE case_id = ${c.id}`,
    );
    expect(reviews.rows.map((x) => x["state"])).toEqual([
      winner.status === "in_review" ? "approved" : "withdrawn",
    ]);
    expect(await caseRowOf(c.id)).toEqual({ version: winner.version, status: winner.status });
  });
});
