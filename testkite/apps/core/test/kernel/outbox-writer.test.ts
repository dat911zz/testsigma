/**
 * Outbox writer — transactional outbox (blueprint §4): any BACKWARD/SIDEWAYS call across the module DAG
 * goes through the krn_outbox table, written in the SAME transaction as the domain write.
 *
 * krn_outbox does NOT enable RLS (the relay must read events for EVERY team); isolation instead comes from
 * least-privilege by role — testkite_app can only INSERT, never SELECT the table.
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
 * drizzle 0.45 wraps the driver error in DrizzleQueryError ("Failed query: ...") and keeps
 * the real Postgres error in `cause` — so the assertion must inspect the whole cause chain, not just
 * the outer message.
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
    () => "DID NOT THROW",
    (e: unknown) => errorChain(e),
  );

describe("enqueueOutbox", () => {
  it("writes the event in the same transaction as the domain write", async () => {
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

  it("ATOMIC: rolling back the domain write ⇒ the event disappears with it", async () => {
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

  it("attaches team_id from TenantContext, never an arbitrary team_id", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "x", payload: {} });
    });
    const r = await t.db.execute(sql`SELECT team_id FROM krn_outbox`);
    expect(r.rows[0]?.["team_id"]).toBe(teamA);
  });

  it("rejects an empty TenantContext", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) =>
        enqueueOutbox(tx, { teamId: "" }, { topic: "x", payload: {} }),
      ),
    ).rejects.toThrow(MissingTenantContextError);
  });

  it("rejects an empty topic", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) =>
        enqueueOutbox(tx, { teamId: teamA }, { topic: "", payload: {} }),
      ),
    ).rejects.toThrow(/topic/i);
  });

  it("returns increasing ids so the relay can order them", async () => {
    const ids = await withTenant(t.db, { teamId: teamA }, async (tx) => [
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: {} }),
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "b", payload: {} }),
    ]);
    expect((ids[1] ?? 0n) > (ids[0] ?? 0n)).toBe(true);
  });

  it("app role can ONLY INSERT into krn_outbox, never SELECT", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: {} });
      expect(await failureOf(tx.execute(sql`SELECT * FROM krn_outbox`))).toMatch(
        /permission denied for table krn_outbox/i,
      );
    });
  });

  it("app role cannot sneak a read of any event's payload, even its own team's", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await enqueueOutbox(tx, { teamId: teamA }, { topic: "a", payload: { secret: 1 } });
      expect(await failureOf(tx.execute(sql`SELECT payload FROM krn_outbox`))).toMatch(
        /permission denied for table krn_outbox/i,
      );
    });
  });
});
