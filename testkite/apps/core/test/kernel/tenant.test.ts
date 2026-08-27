import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { withTenant } from "../../src/modules/kernel/db/tenant.js";
import { MissingTenantContextError, TenantRepo } from "../../src/modules/kernel/db/repo.js";

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
  it("đổi sang role app và set app.team_id bên trong transaction", async () => {
    const out = await withTenant(t.db, { teamId: teamA }, async (tx) => {
      const r = await tx.execute(
        sql`SELECT current_user AS u, current_setting('app.team_id', true) AS tid`,
      );
      return r.rows[0];
    });
    expect(out?.["u"]).toBe("testkite_app");
    expect(out?.["tid"]).toBe(teamA);
  });

  it("chỉ thấy dữ liệu của team mình", async () => {
    const a = await withTenant(t.db, { teamId: teamA }, async (tx) =>
      (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
    );
    const b = await withTenant(t.db, { teamId: teamB }, async (tx) =>
      (await tx.execute(sql`SELECT name FROM projects`)).rows.map((x) => x["name"]),
    );
    expect(a).toEqual(["PA"]);
    expect(b).toEqual(["PB"]);
  });

  it("role và app.team_id revert sau khi tx kết thúc (SET LOCAL)", async () => {
    await withTenant(t.db, { teamId: teamA }, async () => undefined);
    const r = await t.db.execute(
      sql`SELECT current_user AS u, current_setting('app.team_id', true) AS tid`,
    );
    expect(r.rows[0]?.["u"]).not.toBe("testkite_app");
    expect(r.rows[0]?.["tid"] ?? "").toBe("");
  });

  it("ném lỗi khi throw bên trong, và rollback", async () => {
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

  it("từ chối teamId rỗng/không phải uuid TRƯỚC khi mở transaction", async () => {
    await expect(withTenant(t.db, { teamId: "" }, async () => 1)).rejects.toThrow(
      MissingTenantContextError,
    );
    await expect(withTenant(t.db, { teamId: "not-a-uuid" }, async () => 1)).rejects.toThrow(
      MissingTenantContextError,
    );
  });

  it("teamId được bind tham số, không nội suy chuỗi (chống injection)", async () => {
    await expect(
      withTenant(t.db, { teamId: `' ; DROP TABLE projects; --` }, async () => 1),
    ).rejects.toThrow(MissingTenantContextError);
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM projects`);
    expect(r.rows[0]?.["n"]).toBe(2);
  });
});

describe("TenantRepo (L1 fail-closed)", () => {
  class ProjectRepo extends TenantRepo {
    async names(): Promise<readonly string[]> {
      const r = await this.tx.execute(sql`SELECT name FROM projects ORDER BY name`);
      return r.rows.map((x) => String(x["name"]));
    }
  }

  it("repo dùng được trong withTenant", async () => {
    const names = await withTenant(t.db, { teamId: teamA }, async (tx) =>
      new ProjectRepo(tx, { teamId: teamA }).names(),
    );
    expect(names).toEqual(["PA"]);
  });

  it("khởi tạo repo không có TenantContext ⇒ ném ngay tại constructor", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      expect(() => new ProjectRepo(tx, { teamId: "" })).toThrow(MissingTenantContextError);
      return undefined;
    });
  });
});
