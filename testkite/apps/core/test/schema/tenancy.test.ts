import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe("migration tenancy", () => {
  it("creates all 5 tables of the tenancy trio", async () => {
    const r = await t.db.execute(sql`
      SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
    const names = r.rows.map((x) => x["tablename"]);
    for (const n of ["organizations", "teams", "projects", "users", "memberships"]) {
      expect(names).toContain(n);
    }
  });

  it("projects has UNIQUE(team_id, id) — the anchor for composite FKs", async () => {
    const r = await t.db.execute(sql`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t2 ON t2.oid = c.conrelid
      WHERE t2.relname = 'projects' AND c.contype = 'u'`);
    const defs = r.rows.map((x) => String(x["def"]));
    expect(defs.some((d) => d.includes("UNIQUE (team_id, id)"))).toBe(true);
  });

  it("every tenant-scoped table has an index leading with team_id", async () => {
    for (const tbl of ["projects", "memberships"]) {
      const r = await t.db.execute(sql`
        SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = ${tbl}`);
      const defs = r.rows.map((x) => String(x["indexdef"]));
      expect(defs.some((d) => /\(team_id[,)]/.test(d))).toBe(true);
    }
  });

  it("memberships UNIQUE(team_id, user_id) — one person, one role in a team", async () => {
    const org = await t.db.execute(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const orgId = String(org.rows[0]?.["id"]);
    const team = await t.db.execute(
      sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId},'QA','qa') RETURNING id`,
    );
    const teamId = String(team.rows[0]?.["id"]);
    const user = await t.db.execute(
      sql`INSERT INTO users (email, display_name) VALUES ('a@b.c','A') RETURNING id`,
    );
    const userId = String(user.rows[0]?.["id"]);
    await t.db.execute(
      sql`INSERT INTO memberships (team_id, user_id, role) VALUES (${teamId},${userId},'author')`,
    );
    // drizzle-orm 0.45 WRAPS the driver error: `message` is only "Failed query: ..." while
    // the real Postgres message (SQLSTATE + constraint name) lives in `cause`.
    // So assert directly on `cause` — stricter than a regex on the message.
    const err: unknown = await t.db
      .execute(
        sql`INSERT INTO memberships (team_id, user_id, role) VALUES (${teamId},${userId},'viewer')`,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const cause = (err as { readonly cause?: { code?: string; constraint?: string } } | undefined)
      ?.cause;
    expect(cause?.code).toBe("23505"); // unique_violation
    expect(cause?.constraint).toBe("memberships_team_user_unique");
  });

  it("membership_role is an enum with exactly blueprint §3's 6 roles", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'membership_role' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual([
      "instance_operator",
      "org_admin",
      "team_admin",
      "author",
      "runner",
      "viewer",
    ]);
  });
});
