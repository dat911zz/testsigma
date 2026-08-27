/**
 * Relay outbox — vòng đọc `krn_outbox` rồi giao cho một `Publisher` tiêm từ ngoài.
 *
 * Ba tính chất được canh gác ở đây:
 *  1. IDEMPOTENT theo cặp (outbox_id, consumer) — chạy lại không publish lại,
 *     nhưng consumer khác vẫn nhận được cùng event.
 *  2. IDEMPOTENT cả khi danh sách candidate đã CŨ — event bị relay khác cùng consumer
 *     đánh dấu consumed *sau* câu SELECT batch thì không được publish lần hai.
 *  3. AT-LEAST-ONCE — publish ném ⇒ không đánh dấu consumed, tăng attempts, lùi
 *     available_at; một event hỏng không chặn phần còn lại của batch.
 *
 * GIỚI HẠN ĐÃ BIẾT: PGlite chỉ có MỘT connection ⇒ KHÔNG tồn tại tranh chấp khoá,
 * nên ngữ nghĩa disjoint của SKIP LOCKED không thể chứng minh ở tầng này (test cuối
 * chỉ là hợp đồng tĩnh). Bằng chứng hành vi thật nằm ở test/concurrency (Postgres thật).
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
 * Bọc `db` để chèn sự kiện của MỘT RELAY KHÁC vào đúng cửa sổ đua: sau khi câu SELECT
 * batch đã chốt danh sách candidate, trước khi transaction khoá row đầu tiên chạy.
 *
 * Vì sao phải bọc: PGlite chỉ có một connection nên không dựng được hai `runRelayOnce`
 * chạy song song thật (mọi query xếp hàng qua transaction-mutex; gọi query lồng bên
 * trong một transaction sẽ khoá chết). Wrapper này tái hiện ĐÚNG trạng thái DB mà relay
 * B để lại trên Postgres thật: consumed đã COMMIT và row đã HẾT khoá — nên
 * `FOR UPDATE SKIP LOCKED` của relay A không skip, và chỉ điều kiện NOT EXISTS
 * ngay trong câu khoá mỗi-row mới chặn được publish lần hai.
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
  it("publish mọi event chưa tiêu thụ, theo thứ tự id", async () => {
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

  it("IDEMPOTENT: chạy lần 2 không publish lại gì", async () => {
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

  it("IDEMPOTENT: relay khác cùng consumer consume xong SAU câu SELECT batch ⇒ không publish lại", async () => {
    await seed(2);
    const seen: string[] = [];
    const raced = raceBeforeFirstTx(t.db, async () => {
      // Relay B: publish xong t1 và COMMIT consumed. Row t1 KHÔNG còn bị khoá.
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

  it("consumer khác vẫn nhận được cùng event (PK ghép outbox_id+consumer)", async () => {
    await seed(2);
    await runRelayOnce(t.db, async () => undefined, { consumer: "relay-1" });
    const res = await runRelayOnce(t.db, async () => undefined, { consumer: "relay-2" });
    expect(res.published).toBe(2);
    expect(await consumedCount()).toBe(4);
  });

  it("publish lỗi ⇒ KHÔNG đánh dấu consumed, tăng attempts, lùi available_at", async () => {
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

  it("một event lỗi KHÔNG chặn các event còn lại trong batch", async () => {
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

  it("bỏ qua event chưa tới available_at", async () => {
    await seed(1);
    await t.db.execute(sql`UPDATE krn_outbox SET available_at = now() + interval '1 hour'`);
    const res = await runRelayOnce(t.db, async () => undefined, { consumer: "relay-1" });
    expect(res.claimed).toBe(0);
  });

  it("bỏ qua event vượt maxAttempts (dead-letter tại chỗ)", async () => {
    await seed(1);
    await t.db.execute(sql`UPDATE krn_outbox SET attempts = 5`);
    const res = await runRelayOnce(t.db, async () => undefined, {
      consumer: "relay-1",
      maxAttempts: 5,
    });
    expect(res.claimed).toBe(0);
  });

  it("tôn trọng batchSize", async () => {
    await seed(5);
    const res = await runRelayOnce(t.db, async () => undefined, {
      consumer: "relay-1",
      batchSize: 2,
    });
    expect(res.claimed).toBe(2);
  });

  it("dùng FOR UPDATE SKIP LOCKED trong câu claim", async () => {
    // Hợp đồng tĩnh: PGlite một connection nên KHÔNG thể chứng minh disjoint ở đây.
    // Chứng minh hành vi thật nằm ở test/concurrency/relay-race.test.ts (Postgres thật).
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/modules/kernel/outbox/relay.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
  });
});
