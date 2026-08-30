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

  /** 20 unpublished events for team A and no consumed markers — one round's worth of work. */
  const seedOutbox = async (): Promise<void> => {
    await r.db.execute(sql`TRUNCATE krn_outbox_consumed, krn_outbox RESTART IDENTITY CASCADE`);
    await withTenant(r.db, { teamId: teamA }, async (tx) => {
      for (let i = 0; i < 20; i += 1) {
        await enqueueOutbox(tx, { teamId: teamA }, { topic: `t${i}`, payload: { i } });
      }
    });
  };

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
    await seedOutbox();
  });

  it("two relays running in parallel: each event is published EXACTLY ONCE", async () => {
    // ROUNDS, not one shot. The duplicate this test exists to catch needs one relay's snapshot
    // to be taken in the microseconds before the other relay commits (see the statement-order
    // test below), so a single round is a weak detector: measured on 2026-08-30 against the
    // merged-statement relay, one round went red roughly one run in five — i.e. it waved the
    // regression through four times out of five. Eight rounds cost ~1.2s and make it ~85%.
    for (let round = 1; round <= 8; round += 1) {
      await seedOutbox();
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
      expect(new Set(ids).size, `round ${String(round)} published one event twice`).toBe(ids.length); // NO duplicates
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
    }
  });

  it("takes the row lock BEFORE it checks consumed — merging the two publishes twice", async () => {
    // The engine rule behind runRelayOnce's two statements, reproduced deterministically with
    // `pg_sleep` where the real race is microseconds wide: under READ COMMITTED a statement's
    // snapshot is taken when the statement STARTS, while its row lock is taken after the qual
    // has been evaluated. A relay that commits in that gap is invisible to a `NOT EXISTS
    // (consumed)` inside the locking statement, yet its lock is already released — so the
    // merged form hands out a row that has been published and finishes publishing it a second
    // time. Splitting the check into its own statement takes a snapshot AFTER the lock is
    // granted, which cannot miss that commit.
    const first = await r.db.execute(sql`SELECT id FROM krn_outbox ORDER BY id LIMIT 1`);
    const id = String(first.rows[0]?.["id"]);
    const merged = await r.pool.connect();
    const other = await r.pool.connect();
    try {
      await merged.query("BEGIN");
      // Starts NOW (snapshot), spends 300ms in the qual, and only then reaches for the lock.
      const mergedRows = merged.query(
        `SELECT o.id FROM krn_outbox o
          WHERE o.id = $1
            AND NOT EXISTS (SELECT 1 FROM krn_outbox_consumed c
                             WHERE c.outbox_id = o.id AND c.consumer = 'relay-1')
            AND (SELECT true FROM pg_sleep(0.3))
          FOR UPDATE SKIP LOCKED`,
        [id],
      );
      await new Promise((res) => setTimeout(res, 100));
      // The other relay publishes the row and commits, well inside the first one's statement.
      await other.query("BEGIN");
      await other.query(`SELECT id FROM krn_outbox WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
      await other.query(
        `INSERT INTO krn_outbox_consumed (outbox_id, consumer) VALUES ($1, 'relay-1')
         ON CONFLICT DO NOTHING`,
        [id],
      );
      await other.query("COMMIT");

      expect(
        (await mergedRows).rows,
        "the merged form still hands out an event another relay has already published",
      ).toHaveLength(1);
      // The split form, from the same transaction that just proved the merged one wrong: the
      // lock is free (the publisher committed), but the SECOND statement sees the marker.
      const recheck = await merged.query(
        `SELECT 1 AS hit FROM krn_outbox_consumed WHERE outbox_id = $1 AND consumer = 'relay-1'`,
        [id],
      );
      expect(recheck.rows, "the split form skips it — this is what the relay does").toHaveLength(1);
      await merged.query("ROLLBACK");
    } finally {
      merged.release();
      other.release();
    }
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
