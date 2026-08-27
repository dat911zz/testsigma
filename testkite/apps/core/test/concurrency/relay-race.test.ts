/**
 * Tầng test CONCURRENCY — chỉ chạy trên Postgres THẬT (nhiều connection).
 *
 * VÌ SAO KHÔNG NẰM Ở TẦNG PGlite: PGlite chỉ có MỘT connection wasm, hai transaction
 * đồng thời chỉ xếp hàng tuần tự (spike 2026-08-27) ⇒ mọi khẳng định "SKIP LOCKED
 * claim disjoint" test ở đó đều XANH GIẢ. Bằng chứng thật (PG 16.13 local): conn A
 * giữ khoá ids=[1,2], conn B SKIP LOCKED nhận ids=[3,4] (disjoint), còn FOR UPDATE
 * thường thì BLOCKED sau 602ms.
 *
 * Không có TESTKITE_TEST_PG_URL ⇒ cả suite này skip (máy dev không có Postgres vẫn
 * `pnpm test` xanh). CI luôn set biến này với postgres:17 — engine có thẩm quyền.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";
import { withTenant } from "../../src/modules/kernel/db/tenant.js";
import { enqueueOutbox } from "../../src/modules/kernel/outbox/writer.js";
import { runRelayOnce, type OutboxRecord } from "../../src/modules/kernel/outbox/relay.js";

describeRealPg("relay dưới tranh chấp THẬT (Postgres thật, nhiều connection)", () => {
  let r: RealDb;
  let teamA = "";

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });

  beforeEach(async () => {
    await r.db.execute(
      sql`TRUNCATE krn_outbox_consumed, krn_outbox, aut_cases, memberships, projects, teams, organizations RESTART IDENTITY CASCADE`,
    );
    const org = await r.db.execute(
      sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const orgId = String(org.rows[0]?.["id"]);
    const a = await r.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
    );
    teamA = String(a.rows[0]?.["id"]);
    await withTenant(r.db, { teamId: teamA }, async (tx) => {
      for (let i = 0; i < 20; i += 1) {
        await enqueueOutbox(tx, { teamId: teamA }, { topic: `t${i}`, payload: { i } });
      }
    });
  });

  it("hai relay chạy song song: mỗi event publish ĐÚNG MỘT LẦN", async () => {
    const seenA: OutboxRecord[] = [];
    const seenB: OutboxRecord[] = [];
    const slow = (bucket: OutboxRecord[]) => async (rec: OutboxRecord) => {
      await new Promise((res) => setTimeout(res, 5));
      bucket.push(rec);
    };
    await Promise.all([
      runRelayOnce(r.db, slow(seenA), { consumer: "relay-1" }),
      runRelayOnce(r.db, slow(seenB), { consumer: "relay-1" }),
    ]);
    const ids = [...seenA, ...seenB].map((x) => String(x.id));
    expect(new Set(ids).size).toBe(ids.length); // KHÔNG trùng
    const consumed = await r.db.execute(sql`SELECT count(*)::int AS n FROM krn_outbox_consumed`);
    expect(Number(consumed.rows[0]?.["n"])).toBe(20);
  });

  it("SKIP LOCKED cho claim disjoint khi một connection đang giữ khoá", async () => {
    const a = await r.pool.connect();
    const b = await r.pool.connect();
    try {
      await a.query("BEGIN");
      const ra = await a.query(`SELECT id FROM krn_outbox ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 5`);
      const rb = await b.query(`SELECT id FROM krn_outbox ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 5`);
      const idsA = ra.rows.map((x) => String(x["id"]));
      const idsB = rb.rows.map((x) => String(x["id"]));
      expect(idsA.length).toBe(5);
      expect(idsB.length).toBe(5);
      expect(idsA.filter((x) => idsB.includes(x))).toEqual([]);
      await a.query("ROLLBACK");
    } finally {
      a.release();
      b.release();
    }
  });

  it("RLS vẫn cách ly khi qua pool nhiều connection", async () => {
    const org = await r.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const orgId = String(org.rows[0]?.["id"]);
    const bTeam = await r.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`,
    );
    const teamB = String(bTeam.rows[0]?.["id"]);
    await r.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa')`);
    await r.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamB},'PB','pb')`);
    const [na, nb] = await Promise.all([
      withTenant(r.db, { teamId: teamA }, async (tx) =>
        (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
      ),
      withTenant(r.db, { teamId: teamB }, async (tx) =>
        (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
      ),
    ]);
    expect(na).toEqual(["PA"]);
    expect(nb).toEqual(["PB"]);
  });

  it("session var KHÔNG rò sang connection kế tiếp trong pool", async () => {
    await withTenant(r.db, { teamId: teamA }, async () => undefined);
    const checks = await Promise.all(
      Array.from({ length: 5 }, () =>
        r.db.execute(sql`SELECT current_setting('app.team_id', true) AS tid`),
      ),
    );
    for (const c of checks) expect(c.rows[0]?.["tid"] ?? "").toBe("");
  });
});
