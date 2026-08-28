import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { withAuthRole, withTenant } from "../../src/modules/kernel/db/tenant.js";
import { MissingTenantContextError, TenantRepo } from "../../src/modules/kernel/db/repo.js";
import { APP_ROLE, AUTH_ROLE } from "../../src/modules/kernel/db/schema.js";

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
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PA','pa')`);
  await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamB},'PB','pb')`);
});

describe("withTenant", () => {
  it("switches to the app role and sets app.team_id inside the transaction", async () => {
    const out = await withTenant(t.db, { teamId: teamA }, async (tx) => {
      const r = await tx.execute(
        sql`SELECT current_user AS u, current_setting('app.team_id', true) AS tid`,
      );
      return r.rows[0];
    });
    expect(out?.["u"]).toBe("testkite_app");
    expect(out?.["tid"]).toBe(teamA);
  });

  it("only sees its own team's data", async () => {
    const a = await withTenant(t.db, { teamId: teamA }, async (tx) =>
      (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
    );
    const b = await withTenant(t.db, { teamId: teamB }, async (tx) =>
      (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
    );
    expect(a).toEqual(["PA"]);
    expect(b).toEqual(["PB"]);
  });

  it("role and app.team_id revert once the tx ends (SET LOCAL)", async () => {
    await withTenant(t.db, { teamId: teamA }, async () => undefined);
    const r = await t.db.execute(
      sql`SELECT current_user AS u, current_setting('app.team_id', true) AS tid`,
    );
    expect(r.rows[0]?.["u"]).not.toBe("testkite_app");
    expect(r.rows[0]?.["tid"] ?? "").toBe("");
  });

  it("propagates a throw from inside, and rolls back", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) => {
        await tx.execute(
          sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamA},'PX','px')`,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
    expect(r.rows[0]?.["n"]).toBe(2);
  });

  it("rejects an empty/non-uuid teamId BEFORE opening the transaction", async () => {
    await expect(withTenant(t.db, { teamId: "" }, async () => 1)).rejects.toThrow(
      MissingTenantContextError,
    );
    await expect(withTenant(t.db, { teamId: "not-a-uuid" }, async () => 1)).rejects.toThrow(
      MissingTenantContextError,
    );
  });

  it("teamId is bound as a parameter, never interpolated into the string (anti-injection)", async () => {
    await expect(
      withTenant(t.db, { teamId: `' ; DROP TABLE projects; --` }, async () => 1),
    ).rejects.toThrow(MissingTenantContextError);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
    expect(r.rows[0]?.["n"]).toBe(2);
  });
});

describe("APP_ROLE / AUTH_ROLE are safe to interpolate raw into SQL (NIT-36)", () => {
  // tenant.ts does `sql.raw(\`SET LOCAL ROLE ${APP_ROLE}\`)` / `${AUTH_ROLE}` — safe ONLY
  // because both are our own compile-time constants, not user input, as the comments right
  // there say. That assumption was previously asserted only in a comment, not by any
  // machine-checked test — this canary turns it into one: an unquoted identifier (matches
  // Postgres's bare-identifier syntax), which also means neither value could carry a `;` or
  // whitespace that would break out of `SET LOCAL ROLE <here>` into a second statement.
  const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

  it("APP_ROLE matches a safe bare SQL identifier", () => {
    expect(APP_ROLE).toMatch(IDENTIFIER);
  });

  it("AUTH_ROLE matches a safe bare SQL identifier", () => {
    expect(AUTH_ROLE).toMatch(IDENTIFIER);
  });

  it("withAuthRole actually switches to that role (end-to-end, not just the constant's shape)", async () => {
    const row = await withAuthRole(t.db, async (tx) => {
      const r = await tx.execute(sql`SELECT current_user AS u`);
      return r.rows[0];
    });
    expect(row?.["u"]).toBe(AUTH_ROLE);
  });
});

describe("TenantRepo (L1 fail-closed)", () => {
  class ProjectRepo extends TenantRepo {
    async names(): Promise<readonly string[]> {
      const r = await this.tx.execute(sql`SELECT name FROM projects ORDER BY name`);
      return r.rows.map((x) => String(x["name"]));
    }
  }

  it("the repo can be used inside withTenant", async () => {
    const names = await withTenant(t.db, { teamId: teamA }, async (tx) =>
      new ProjectRepo(tx, { teamId: teamA }).names(),
    );
    expect(names).toEqual(["PA"]);
  });

  it("constructing a repo without a TenantContext ⇒ throws immediately in the constructor", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      expect(() => new ProjectRepo(tx, { teamId: "" })).toThrow(MissingTenantContextError);
      return undefined;
    });
  });
});
