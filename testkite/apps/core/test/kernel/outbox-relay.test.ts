/**
 * Outbox relay — a loop that reads `krn_outbox` then hands each event to a `Publisher` injected from outside.
 *
 * Three properties are guarded here:
 *  1. IDEMPOTENT per (outbox_id, consumer) pair — running again does not publish again,
 *     but a different consumer still receives the same event.
 *  2. IDEMPOTENT even when the candidate list is STALE — an event marked consumed by another relay
 *     on the same consumer *after* the batch SELECT must not be published a second time.
 *  3. AT-LEAST-ONCE — if publish throws ⇒ do not mark consumed, increment attempts, push back
 *     available_at; one bad event does not block the rest of the batch.
 *
 * KNOWN LIMITATION: PGlite has only ONE connection ⇒ lock contention CANNOT exist,
 * so SKIP LOCKED's disjoint semantics can't be proven at this layer (the last test is
 * only a static contract). Real behavioral proof lives in test/concurrency (real Postgres).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueOutbox } from "../../src/modules/kernel/outbox/writer.js";
import { runRelayOnce, type OutboxRecord } from "../../src/modules/kernel/outbox/relay.js";
import { withTenant } from "../../src/modules/kernel/db/tenant.js";
import type { TkDb } from "../../src/modules/kernel/db/types.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamA = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(
    sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`,
  );
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  teamA = String(a.rows[0]?.["id"]);
});

async function seed(n: number): Promise<void> {
  await withTenant(t.db, { teamId: teamA }, async (tx) => {
    for (let i = 0; i < n; i += 1) {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: `t${i}`, payload: { i } });
    }
  });
}

/**
 * Wrap `db` to inject a DIFFERENT RELAY's event right into the race window: after the batch
 * SELECT has fixed the candidate list, before the transaction that locks the first row runs.
 *
 * Why wrapping is needed: PGlite has only one connection, so two `runRelayOnce` calls can't
 * truly run in parallel (every query queues through the transaction mutex; a nested query call
 * inside a transaction deadlocks). This wrapper reproduces the EXACT DB state relay
 * B would leave on real Postgres: consumed has COMMITted and the row is UNLOCKED — so
 * relay A's `FOR UPDATE SKIP LOCKED` does not skip it, and only the NOT EXISTS condition
 * right in the per-row locking query blocks the second publish.
 */
function raceBeforeFirstTx(base: TkDb, otherRelayCommits: () => Promise<void>): TkDb {
  let fired = false;
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return async (fn: Parameters<TkDb["transaction"]>[0]): Promise<unknown> => {
        if (!fired) {
          fired = true;
          await otherRelayCommits();
        }
        return target.transaction(fn);
      };
    },
  });
}

const consumedCount = async (): Promise<number> => {
  const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM krn_outbox_consumed`);
  return Number(r.rows[0]?.["n"]);
};

describe("runRelayOnce", () => {
  it("publishes every unconsumed event, in id order", async () => {
    await seed(3);
    const seen: OutboxRecord[] = [];
    const res = await runRelayOnce(
      t.db,
      async (r) => {
        seen.push(r);
      },
      { consumer: "relay-1" },
    );
    expect(res).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(seen.map((r) => r.topic)).toEqual(["t0", "t1", "t2"]);
    expect(seen[0]?.payload).toEqual({ i: 0 });
    expect(seen[0]?.teamId).toBe(teamA);
    expect(await consumedCount()).toBe(3);
  });

  it("IDEMPOTENT: a second run publishes nothing again", async () => {
    await seed(2);
    await runRelayOnce(t.db, async () => undefined, { consumer: "relay-1" });
    const seen: OutboxRecord[] = [];
    const res = await runRelayOnce(
      t.db,
      async (r) => {
        seen.push(r);
      },
      { consumer: "relay-1" },
    );
    expect(res).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(seen).toEqual([]);
  });

  it("IDEMPOTENT: another relay on the same consumer finishes consuming AFTER the batch SELECT ⇒ no republish", async () => {
    await seed(2);
    const seen: string[] = [];
    const raced = raceBeforeFirstTx(t.db, async () => {
      // Relay B: finished publishing t1 and COMMITted consumed. Row t1 is NO LONGER locked.
      await t.db.execute(sql`
        INSERT INTO krn_outbox_consumed (outbox_id, consumer)
        SELECT id, 'relay-1' FROM krn_outbox WHERE topic = 't1'`);
    });
    const res = await runRelayOnce(
      raced,
      async (r) => {
        seen.push(r.topic);
      },
      { consumer: "relay-1" },
    );
    expect(seen).toEqual(["t0"]);
    expect(res).toEqual({ claimed: 2, published: 1, failed: 0 });
    expect(await consumedCount()).toBe(2);
  });

  it("a different consumer still receives the same event (composite PK outbox_id+consumer)", async () => {
    await seed(2);
    await runRelayOnce(t.db, async () => undefined, { consumer: "relay-1" });
    const res = await runRelayOnce(t.db, async () => undefined, { consumer: "relay-2" });
    expect(res.published).toBe(2);
    expect(await consumedCount()).toBe(4);
  });

  it("publish fails ⇒ does NOT mark consumed, increments attempts, pushes back available_at", async () => {
    await seed(1);
    const res = await runRelayOnce(
      t.db,
      async () => {
        throw new Error("broker down");
      },
      { consumer: "relay-1", backoffMs: 60_000 },
    );
    expect(res).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(await consumedCount()).toBe(0);
    const r = await t.db.execute(sql`
      SELECT attempts, last_error, available_at > now() AS deferred FROM krn_outbox`);
    expect(r.rows[0]?.["attempts"]).toBe(1);
    expect(String(r.rows[0]?.["last_error"])).toContain("broker down");
    expect(r.rows[0]?.["deferred"]).toBe(true);
  });

  it("one failed event does NOT block the rest of the batch", async () => {
    await seed(3);
    const res = await runRelayOnce(
      t.db,
      async (r) => {
        if (r.topic === "t1") throw new Error("nope");
      },
      { consumer: "relay-1" },
    );
    expect(res).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(await consumedCount()).toBe(2);
  });

  it("skips events that haven't reached available_at yet", async () => {
    await seed(1);
    await t.db.execute(sql`UPDATE krn_outbox SET available_at = now() + interval '1 hour'`);
    const res = await runRelayOnce(t.db, async () => undefined, { consumer: "relay-1" });
    expect(res.claimed).toBe(0);
  });

  it("skips events over maxAttempts (dead-letter in place)", async () => {
    await seed(1);
    await t.db.execute(sql`UPDATE krn_outbox SET attempts = 5`);
    const res = await runRelayOnce(t.db, async () => undefined, {
      consumer: "relay-1",
      maxAttempts: 5,
    });
    expect(res.claimed).toBe(0);
  });

  it("honors batchSize", async () => {
    await seed(5);
    const res = await runRelayOnce(t.db, async () => undefined, {
      consumer: "relay-1",
      batchSize: 2,
    });
    expect(res.claimed).toBe(2);
  });

  it("uses FOR UPDATE SKIP LOCKED in the claim query", async () => {
    // Static contract: PGlite has one connection so disjointness CANNOT be proven here.
    // Real behavioral proof lives in test/concurrency/relay-race.test.ts (real Postgres).
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/modules/kernel/outbox/relay.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
  });
});
