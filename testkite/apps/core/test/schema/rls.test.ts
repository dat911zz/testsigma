import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { APP_ROLE, AUTH_ROLE } from "../../src/modules/kernel/index.js";

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
    sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
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
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa')`);
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamB},'PB','pb')`);
});

/** Run a block of SQL exactly like the real request path: app role + app.team_id. */
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

describe("RLS L2.5", () => {
  it("role testkite_app is NOT a superuser and does NOT bypassrls", async () => {
    const r = await t.db.execute(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'testkite_app'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.["rolsuper"]).toBe(false);
    expect(r.rows[0]?.["rolbypassrls"]).toBe(false);
  });

  it("every tenant-scoped table has row security enabled", async () => {
    const r = await t.db.execute(sql`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('teams','projects','memberships') AND relkind='r'`);
    for (const row of r.rows) expect(row["relrowsecurity"]).toBe(true);
    expect(r.rows.length).toBe(3);
  });

  it("SELECT only sees rows for the team in app.team_id", async () => {
    const namesA = await asTeam(teamA, async () =>
      (
        await t.raw.query<{ name: string }>(`SELECT name FROM projects ORDER BY name`)
      ).rows.map((x) => x.name),
    );
    const namesB = await asTeam(teamB, async () =>
      (
        await t.raw.query<{ name: string }>(`SELECT name FROM projects ORDER BY name`)
      ).rows.map((x) => x.name),
    );
    expect(namesA).toEqual(["PA"]);
    expect(namesB).toEqual(["PB"]);
  });

  it("app.team_id NOT set ⇒ 0 rows (fail-closed), no error thrown", async () => {
    await t.raw.exec(`SET ROLE testkite_app`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`);
    await t.raw.exec(`RESET ROLE`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("app.team_id = '' (the shape RESET leaves behind) ⇒ 0 rows, NO 22P02 error", async () => {
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', '', false)`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM projects`);
    await t.raw.exec(`RESET ROLE`);
    await t.raw.exec(`RESET app.team_id`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("WITH CHECK blocks an INSERT into a different team", async () => {
    await expect(
      asTeam(teamA, () =>
        t.raw.query(`INSERT INTO projects (team_id,name,slug) VALUES ($1,'evil','evil')`, [teamB]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("UPDATE/DELETE on another team's row affects 0 rows (invisible, not a 403)", async () => {
    const upd = await asTeam(teamA, () =>
      t.raw.query(`UPDATE projects SET name='hacked' WHERE team_id=$1 RETURNING id`, [teamB]),
    );
    expect(upd.rows.length).toBe(0);
    const del = await asTeam(teamA, () =>
      t.raw.query(`DELETE FROM projects WHERE team_id=$1 RETURNING id`, [teamB]),
    );
    expect(del.rows.length).toBe(0);
  });

  it("policies use NULLIF — no policy directly casts current_setting", async () => {
    const r = await t.db.execute(sql`
      SELECT policyname, qual, roles::text AS roles, cmd, with_check FROM pg_policies WHERE schemaname='public'`);
    expect(r.rows.length).toBeGreaterThanOrEqual(3);
    let tenantPolicies = 0;
    for (const row of r.rows) {
      const roles = String(row["roles"]);
      // The tenant predicate ONLY binds the request-path policy (testkite_app): that's where
      // `''::uuid` would throw 22P02 instead of fail-closed if NULLIF were forgotten.
      if (roles.includes(APP_ROLE)) {
        tenantPolicies += 1;
        expect(String(row["qual"]), `policy ${String(row["policyname"])} is missing NULLIF`).toContain("NULLIF");
        continue;
      }
      // The ONE permitted exception, and it's pinned down tightly: the `auth_lookup` policy
      // of the authentication path (spike 2026-08-28) — it's USING (true) because at token
      // lookup time the tenant is NOT YET known. In exchange it must belong only to
      // testkite_auth, be SELECT-only, and have no with_check (⇒ it can write nothing).
      expect(String(row["policyname"])).toBe("auth_lookup");
      expect(roles).toBe(`{${AUTH_ROLE}}`);
      expect(String(row["cmd"])).toBe("SELECT");
      expect(row["with_check"]).toBeNull();
    }
    expect(tenantPolicies).toBeGreaterThanOrEqual(3);
  });
});
