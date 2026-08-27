/**
 * Outbox writer — transactional outbox (blueprint §4): gọi NGƯỢC/NGANG trên DAG module
 * đi qua bảng krn_outbox, ghi CÙNG transaction với domain write.
 *
 * krn_outbox KHÔNG bật RLS (relay phải đọc event của MỌI team); cách ly thay thế là
 * least-privilege theo role — testkite_app chỉ được INSERT, không được SELECT bảng.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MissingTenantContextError } from "../../src/modules/kernel/db/repo.js";
import { withTenant } from "../../src/modules/kernel/db/tenant.js";
import { enqueueOutbox } from "../../src/modules/kernel/outbox/writer.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamA = "";
let projA = "";

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
  const p = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa') RETURNING id`,
  );
  projA = String(p.rows[0]?.["id"]);
});

const count = async (): Promise<number> => {
  const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM krn_outbox`);
  return Number(r.rows[0]?.["n"]);
};

/**
 * drizzle 0.45 bọc lỗi driver trong DrizzleQueryError ("Failed query: ...") và giữ
 * lỗi Postgres thật ở `cause` — nên khẳng định phải soi cả chuỗi cause, không chỉ
 * message ngoài cùng.
 */
const errorChain = (e: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur instanceof Error && depth < 8; depth += 1) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
};

const failureOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "KHÔNG NÉM LỖI",
    (e: unknown) => errorChain(e),
  );

describe("enqueueOutbox", () => {
  it("ghi event cùng transaction với domain write", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await tx.execute(
        sql`INSERT INTO aut_cases (team_id,project_id,name) VALUES (${teamA},${projA},'c1')`,
      );
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "case.created", payload: { name: "c1" } });
    });
    expect(await count()).toBe(1);
    const r = await t.db.execute(sql`SELECT topic, payload, attempts FROM krn_outbox`);
    expect(r.rows[0]?.["topic"]).toBe("case.created");
    expect(r.rows[0]?.["payload"]).toEqual({ name: "c1" });
    expect(r.rows[0]?.["attempts"]).toBe(0);
  });

  it("ATOMIC: rollback domain write ⇒ event biến mất cùng nó", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO aut_cases (team_id,project_id,name) VALUES (${teamA},${projA},'c2')`,
        );
        await enqueueOutbox(
          tx,
          { teamId: teamA },
          { topic: "case.created", payload: { name: "c2" } },
        );
        throw new Error("domain fail");
      }),
    ).rejects.toThrow("domain fail");
    expect(await count()).toBe(0);
    const c = await t.db.execute(sql`SELECT count(*)::int AS n FROM aut_cases`);
    expect(c.rows[0]?.["n"]).toBe(0);
  });

  it("gắn team_id từ TenantContext, không nhận team_id tuỳ ý", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "x", payload: {} });
    });
    const r = await t.db.execute(sql`SELECT team_id FROM krn_outbox`);
    expect(r.rows[0]?.["team_id"]).toBe(teamA);
  });

  it("từ chối TenantContext rỗng", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) =>
        enqueueOutbox(tx, { teamId: "" }, { topic: "x", payload: {} }),
      ),
    ).rejects.toThrow(MissingTenantContextError);
  });

  it("từ chối topic rỗng", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) =>
        enqueueOutbox(tx, { teamId: teamA }, { topic: "", payload: {} }),
      ),
    ).rejects.toThrow(/topic/i);
  });

  it("trả về id tăng dần để relay sắp thứ tự", async () => {
    const ids = await withTenant(t.db, { teamId: teamA }, async (tx) => [
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: {} }),
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "b", payload: {} }),
    ]);
    expect((ids[1] ?? 0n) > (ids[0] ?? 0n)).toBe(true);
  });

  it("role app CHỈ được INSERT vào krn_outbox, không được SELECT", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: {} });
      expect(await failureOf(tx.execute(sql`SELECT * FROM krn_outbox`))).toMatch(
        /permission denied for table krn_outbox/i,
      );
    });
  });

  it("role app không đọc lén được payload của event nào, kể cả team mình", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: { secret: 1 } });
      expect(await failureOf(tx.execute(sql`SELECT payload FROM krn_outbox`))).toMatch(
        /permission denied for table krn_outbox/i,
      );
    });
  });
});
