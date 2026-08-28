/**
 * `audit_events` — table partitioned by MONTH, append-only AT THE PRIVILEGE LAYER.
 *
 * Every assertion below tracks the exact evidence from the 2026-08-28 spike (start of the
 * M2 identity plan):
 *  - The PK MUST contain the partition key, otherwise Postgres refuses to create the table.
 *  - GRANT on the PARENT is enough (even for partitions created later); GRANT on a CHILD is
 *    a TENANT LEAK because `relrowsecurity` on a child partition is false — the parent's
 *    policy does not apply.
 *  - Don't rely on "code never calls DELETE": the DB must REJECT it (42501), not return 0 rows.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamA = "";
let teamB = "";

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
  const b = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`,
  );
  teamA = String(a.rows[0]?.["id"]);
  teamB = String(b.rows[0]?.["id"]);
});

/** Run a SQL block exactly like the real request path: app role + app.team_id. */
async function asTeam<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  await t.raw.exec(`SET ROLE testkite_app`);
  await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamId]);
  try {
    return await fn();
  } finally {
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
  }
}

describe("audit_events", () => {
  it("is a table partitioned by RANGE(occurred_at)", async () => {
    const r = await t.db.execute(sql`
      SELECT c.relkind, pg_get_partkeydef(c.oid) AS keydef
      FROM pg_class c WHERE c.relname = 'audit_events'`);
    expect(r.rows[0]?.["relkind"]).toBe("p");
    expect(String(r.rows[0]?.["keydef"])).toContain("RANGE (occurred_at)");
  });

  it("PK includes the partition key (Postgres requires it) with team_id leading", async () => {
    const r = await t.db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      JOIN pg_class t2 ON t2.oid = c.conrelid
      WHERE t2.relname='audit_events' AND c.contype='p'`);
    expect(String(r.rows[0]?.["def"])).toBe("PRIMARY KEY (team_id, id, occurred_at)");
  });

  it("has a partition for the current month and at least the next 12 months + default", async () => {
    const r = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname='audit_events'`);
    expect(Number(r.rows[0]?.["n"])).toBeGreaterThanOrEqual(14);
    const def = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_class WHERE relname='audit_events_default'`);
    expect(Number(def.rows[0]?.["n"])).toBe(1);
  });

  it("the app role has NO DELETE/UPDATE/TRUNCATE on the parent table", async () => {
    const r = await t.db.execute(sql`
      SELECT
        has_table_privilege('testkite_app','audit_events','SELECT') AS s,
        has_table_privilege('testkite_app','audit_events','INSERT') AS i,
        has_table_privilege('testkite_app','audit_events','UPDATE') AS u,
        has_table_privilege('testkite_app','audit_events','DELETE') AS d,
        has_table_privilege('testkite_app','audit_events','TRUNCATE') AS tr`);
    expect(r.rows[0]).toMatchObject({ s: true, i: true, u: false, d: false, tr: false });
  });

  it("ensure_audit_partition is NOT executable by the app role (EXECUTE revoked from PUBLIC)", async () => {
    // A plain `CREATE FUNCTION` hands EXECUTE to PUBLIC by default, so this DDL helper —
    // which runs `CREATE TABLE ... PARTITION OF audit_events` — was reachable by every
    // role in the cluster, `testkite_app` included. Nothing on the request path calls it:
    // partitions are created by migrations and by the monthly job, both of which run as
    // the owner. Least privilege here matches the rest of this table's grants.
    const r = await t.db.execute(sql`
      SELECT
        has_function_privilege('testkite_app','ensure_audit_partition(date)','EXECUTE') AS app,
        has_function_privilege('testkite_auth','ensure_audit_partition(date)','EXECUTE') AS auth,
        has_function_privilege('public','ensure_audit_partition(date)','EXECUTE') AS pub`);
    expect(r.rows[0]).toMatchObject({ app: false, auth: false, pub: false });
  });

  it("NO child partition is GRANTed — a child GRANT is a tenant leak", async () => {
    const r = await t.db.execute(sql`
      SELECT c.relname,
             has_table_privilege('testkite_app', c.oid, 'SELECT') AS s,
             has_table_privilege('testkite_app', c.oid, 'INSERT') AS i
      FROM pg_class c JOIN pg_inherits inh ON inh.inhrelid = c.oid
      JOIN pg_class p ON p.oid = inh.inhparent WHERE p.relname='audit_events'`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row["s"], `${String(row["relname"])} was GRANTed SELECT`).toBe(false);
      expect(row["i"], `${String(row["relname"])} was GRANTed INSERT`).toBe(false);
    }
  });

  it("DELETE/UPDATE/TRUNCATE by the app role ⇒ permission denied, not 0 rows", async () => {
    await asTeam(teamA, () =>
      t.raw.query(
        `INSERT INTO audit_events (team_id, actor_kind, action, severity) VALUES ($1,'user','token.issue','HIGH')`,
        [teamA],
      ),
    );
    for (const stmt of [
      `DELETE FROM audit_events`,
      `UPDATE audit_events SET action='x'`,
      `TRUNCATE audit_events`,
    ]) {
      await expect(
        asTeam(teamA, () => t.raw.query(stmt)),
        stmt,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("RLS filters by team through the parent table", async () => {
    await asTeam(teamA, () =>
      t.raw.query(
        `INSERT INTO audit_events (team_id,actor_kind,action,severity) VALUES ($1,'user','a','LOW')`,
        [teamA],
      ),
    );
    await asTeam(teamB, () =>
      t.raw.query(
        `INSERT INTO audit_events (team_id,actor_kind,action,severity) VALUES ($1,'user','b','LOW')`,
        [teamB],
      ),
    );
    const seenA = await asTeam(teamA, async () =>
      (await t.raw.query<{ action: string }>(`SELECT action FROM audit_events`)).rows.map(
        (x) => x.action,
      ),
    );
    expect(seenA).toEqual(["a"]);
  });

  it("WITH CHECK blocks writing an audit event to another team", async () => {
    await expect(
      asTeam(teamA, () =>
        t.raw.query(
          `INSERT INTO audit_events (team_id,actor_kind,action,severity) VALUES ($1,'user','x','LOW')`,
          [teamB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a write outside the range falls into the default partition, NO row lost", async () => {
    await asTeam(teamA, () =>
      t.raw.query(
        `INSERT INTO audit_events (team_id, occurred_at, actor_kind, action, severity)
                   VALUES ($1, now() + interval '10 years', 'system','future','LOW')`,
        [teamA],
      ),
    );
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events_default`);
    expect(Number(r.rows[0]?.["n"])).toBe(1);
  });

  it("index (team_id, occurred_at DESC) exists — audit queries always filter by team + time", async () => {
    const r = await t.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='audit_events'`);
    expect(r.rows.map((x) => String(x["indexdef"])).join("\n")).toMatch(/team_id, occurred_at DESC/);
  });

  it("columns in hand-written SQL match the drizzle definition EXACTLY (no drift)", async () => {
    const { auditEvents } = await import("../../src/modules/governance/db/audit-schema.js");
    const r = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name='audit_events'`);
    const inDb = new Set(r.rows.map((x) => String(x["column_name"])));
    const inTs = Object.values(auditEvents).flatMap((c) =>
      typeof c === "object" && c !== null && "name" in c ? [String((c as { name: string }).name)] : [],
    );
    for (const c of inTs) expect([...inDb], `drizzle declares ${c} but the DB doesn't have it`).toContain(c);
    expect(inTs.length).toBe(inDb.size);
  });
});
