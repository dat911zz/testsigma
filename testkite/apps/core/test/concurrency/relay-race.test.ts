/**
 * The CONCURRENCY test layer — runs ONLY on REAL Postgres (multiple connections).
 *
 * WHY THIS DOESN'T LIVE IN THE PGlite LAYER: PGlite has only ONE wasm connection, two concurrent
 * transactions just queue sequentially (spike 2026-08-27) ⇒ any "SKIP LOCKED
 * claim disjoint" assertion tested there is a FALSE GREEN. Real proof (local PG 16.13): conn A
 * holds the lock on ids=[1,2], conn B's SKIP LOCKED gets ids=[3,4] (disjoint), while a plain
 * FOR UPDATE is BLOCKED for 602ms.
 *
 * No TESTKITE_TEST_PG_URL ⇒ this whole suite skips (a dev machine without Postgres still gets
 * a green `pnpm test`). CI always sets this var with postgres:17 — the engine of record.
 */
import { expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";
import { withTenant } from "../../src/modules/kernel/db/tenant.js";
import { enqueueOutbox } from "../../src/modules/kernel/outbox/writer.js";
import { runRelayOnce, type OutboxRecord } from "../../src/modules/kernel/outbox/relay.js";

describeRealPg("relay under REAL contention (real Postgres, multiple connections)", () => {
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

  it("two relays running in parallel: each event is published EXACTLY ONCE", async () => {
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
    expect(new Set(ids).size).toBe(ids.length); // NO duplicates
    expect(ids.length).toBe(20);
    // Scoped to THIS test's own team + consumer: an unscoped `count(*) FROM
    // krn_outbox_consumed` would also count any row left over from a different context
    // sharing this real Postgres instance, and go red for a reason unrelated to this test.
    const consumed = await r.db.execute(sql`
      SELECT count(*)::int AS n
      FROM krn_outbox_consumed c
      JOIN krn_outbox o ON o.id = c.outbox_id
      WHERE o.team_id = ${teamA} AND c.consumer = 'relay-1'`);
    expect(Number(consumed.rows[0]?.["n"])).toBe(20);
  });

  it("SKIP LOCKED gives a disjoint claim when one connection is holding the lock", async () => {
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

  it("RLS still isolates across a pool of multiple connections", async () => {
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

  it("session var does NOT leak to the next connection in the pool", async () => {
    await withTenant(r.db, { teamId: teamA }, async () => undefined);
    const checks = await Promise.all(
      Array.from({ length: 5 }, () =>
        r.db.execute(sql`SELECT current_setting('app.team_id', true) AS tid`),
      ),
    );
    for (const c of checks) expect(c.rows[0]?.["tid"] ?? "").toBe("");
  });
});
