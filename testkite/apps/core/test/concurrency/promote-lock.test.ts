/**
 * BẰNG CHỨNG cho câu "advisory lock (team, case) hoạt động" — chỉ chạy trên Postgres THẬT.
 *
 * VÌ SAO PHẢI CÓ FILE RIÊNG: test promote ở tầng PGlite (test/authoring/promote.test.ts)
 * chứng minh được "lock CÓ ĐƯỢC LẤY" (canh `pg_locks`), nhưng KHÔNG chứng minh được
 * "lock CÓ TÁC DỤNG": PGlite chỉ có MỘT connection wasm nên hai `withTenant` "song song"
 * ở đó xếp hàng tuần tự — khoá không bao giờ bị tranh chấp, test xanh kể cả khi bỏ khoá.
 * Tranh chấp thật đòi hai connection thật, tức Postgres thật.
 *
 * Bốn mệnh đề được đo ở đây:
 *  1. hai `promoteCase` song song cùng `expectedVersion` ⇒ ĐÚNG MỘT thắng, bên thua
 *     thất bại CÓ KIỂM SOÁT (409 hợp đồng, không phải lỗi hạ tầng);
 *  2. DB sau cuộc đua khớp bên thắng — đúng một row `ready`, version bump ĐÚNG MỘT lần,
 *     `ready_revision_id` được ghim (không có promote nào ghi đè lung tung);
 *  3. khoá THẬT SỰ chặn: giữ khoá ở connection A thì connection B phải chờ;
 *  4. khoá theo (team, case) chứ không toàn cục: case khác ⇒ không chặn nhau.
 *
 * Không có TESTKITE_TEST_PG_URL ⇒ cả suite skip (`eval "$(scripts/test-pg.sh start)"` để
 * dựng cluster tạm). CI job postgres:17 luôn set biến ⇒ CI là nơi bằng chứng được thu.
 *
 * LỆCH CÓ CHỦ ĐÍCH SO VỚI BLOCK TRONG PLAN — thêm cổng chặn `makeGate(2)` (y hệt
 * review-state-race.test.ts) vào hai test đầu. ĐO THẬT trên PostgreSQL 16.13, sau khi gỡ
 * `cases.lockCase(...)` khỏi `loadForMutation`:
 *   - block NGUYÊN VĂN của plan: `Test Files 1 passed | Tests 4 passed` — XANH kể cả khi
 *     KHÔNG có khoá, tức nó không chứng minh gì cả. Nguyên nhân gốc: `Promise.all` khởi
 *     động hai `withTenant`, nhưng bên thứ hai phải mở một connection VẬT LÝ MỚI (pool
 *     lạnh, TCP + auth) nên nó đọc `version` SAU khi bên thứ nhất đã COMMIT — hai
 *     transaction không bao giờ chồng lấn ở cửa sổ check-then-act. Đúng loại "xanh giả"
 *     mà chính task này sinh ra để diệt;
 *   - với cổng chặn: cả hai transaction đã BEGIN + `SET LOCAL ROLE` + `set_config` xong
 *     rồi mới có bên nào được đọc ⇒ gỡ khoá là ĐỎ ngay (`expected 2 to be 1`, cả hai
 *     promote cùng trả version 5 — lost update im lặng).
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { createCase, replaceSteps } from "../../src/modules/authoring/case-service.js";
import {
  decideReview,
  promoteCase,
  submitForReview,
} from "../../src/modules/authoring/review-service.js";
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

/**
 * Lệch có chủ đích so với block trong plan: plan viết
 * `expect((loser as { httpStatus?: number }).httpStatus).toBe(409)`.
 * Cast từ `unknown` sang một shape là thứ chuẩn code TestKite cấm, và nó còn YẾU hơn:
 * nếu `loser` là `undefined` (cả hai cùng thắng — đúng hỏng hóc task này săn) thì phép
 * cast ném TypeError, test đỏ vì lý do sai. Hàm dưới đây trả `undefined` cho mọi thứ
 * không phải lỗi có `httpStatus`, nên assertion `toBe(409)` bắt đúng cả hai kiểu hỏng.
 */
function httpStatusOf(value: unknown): number | undefined {
  if (!(value instanceof Error)) return undefined;
  const status: unknown = (value as { readonly httpStatus?: unknown }).httpStatus;
  return typeof status === "number" ? status : undefined;
}

describeRealPg("promote dưới tranh chấp thật (Postgres thật, hai connection)", () => {
  let r: RealDb;
  let teamId = "";
  let projectId = "";
  const alice = { userId: "" };
  const bob = { userId: "" };
  const carol = { userId: "" };

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
    for (const [email, name, holder] of [
      ["a@x.test", "Alice", alice],
      ["b@x.test", "Bob", bob],
      ["c@x.test", "Carol", carol],
    ] as const) {
      const u = await r.db.execute(
        sql`INSERT INTO users (email, display_name) VALUES (${email},${name}) RETURNING id`,
      );
      holder.userId = String(u.rows[0]?.["id"]);
    }
  });

  const ctx = (): { teamId: string } => ({ teamId });

  /**
   * Case đã được duyệt và SẴN SÀNG promote. Alice là người-sửa-cuối, Bob là người duyệt
   * ⇒ cả Bob lẫn Carol đều qua được cửa four-eyes (403 four-eyes không được phép làm
   * nhiễu bằng chứng về khoá).
   */
  async function approvedCase(): Promise<{ id: string; version: number }> {
    const created = await withTenant(r.db, ctx(), (tx) =>
      createCase(tx, ctx(), alice, { projectId, name: "Checkout", isStepGroup: false }),
    );
    const edited = await withTenant(r.db, ctx(), (tx) =>
      replaceSteps(tx, ctx(), alice, {
        caseId: created.id,
        expectedVersion: created.version,
        steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }],
      }),
    );
    const submitted = await withTenant(r.db, ctx(), (tx) =>
      submitForReview(tx, ctx(), alice, { caseId: edited.id, expectedVersion: edited.version }),
    );
    const decided = await withTenant(r.db, ctx(), (tx) =>
      decideReview(tx, ctx(), bob, {
        caseId: edited.id,
        expectedVersion: submitted.version,
        decision: "approved",
      }),
    );
    return { id: decided.id, version: decided.version };
  }

  it("hai promote song song: ĐÚNG MỘT cái thắng, cái kia thất bại có kiểm soát", async () => {
    const c = await approvedCase();
    const gate = makeGate(2);
    const attempt = (): Promise<unknown> =>
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version });
      })
        .then(() => "ok" as const)
        .catch((e: unknown) => e);

    const [x, y] = await Promise.all([attempt(), attempt()]);
    const okCount = [x, y].filter((v) => v === "ok").length;
    expect(okCount).toBe(1);

    // Cái thua KHÔNG được là lỗi hạ tầng — phải là 409 (version đã bị cái thắng bump).
    const loser = [x, y].find((v) => v !== "ok");
    expect(httpStatusOf(loser)).toBe(409);
  });

  it("promote nối tiếp không sinh ready_revision_id lung tung — đúng 1 row ready", async () => {
    const c = await approvedCase();
    const gate = makeGate(2);
    await Promise.all([
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), bob, { caseId: c.id, expectedVersion: c.version });
      }).catch(() => undefined),
      withTenant(r.db, ctx(), async (tx) => {
        await gate();
        return promoteCase(tx, ctx(), carol, { caseId: c.id, expectedVersion: c.version });
      }).catch(() => undefined),
    ]);
    const res = await r.db.execute(sql`
      SELECT status, version, ready_revision_id, promoted_by FROM aut_cases WHERE id = ${c.id}`);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.["status"]).toBe("ready");
    expect(Number(res.rows[0]?.["version"])).toBe(c.version + 1);
    expect(res.rows[0]?.["ready_revision_id"]).not.toBeNull();
  });

  it("advisory lock THẬT SỰ chặn: giữ khoá ở connection A thì connection B phải chờ", async () => {
    const c = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        c.id,
      ]);

      let bAcquired = false;
      const bPromise = (async () => {
        await b.query("BEGIN");
        await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
          teamId,
          c.id,
        ]);
        bAcquired = true;
        await b.query("COMMIT");
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));
      // Bằng chứng lock có tranh chấp thật — thứ PGlite KHÔNG THỂ chứng minh.
      expect(bAcquired).toBe(false);

      await a.query("COMMIT");
      await bPromise;
      expect(bAcquired).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });

  it("khoá của case KHÁC không chặn nhau (khoá theo (team, case), không phải khoá toàn cục)", async () => {
    const c1 = await approvedCase();
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        c1.id,
      ]);
      await b.query("BEGIN");
      // case id khác ⇒ khoá khác ⇒ lấy được ngay, không chờ.
      await b.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        teamId,
        "00000000-0000-0000-0000-0000000000ff",
      ]);
      await b.query("COMMIT");
      await a.query("COMMIT");
      expect(true).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });
});
