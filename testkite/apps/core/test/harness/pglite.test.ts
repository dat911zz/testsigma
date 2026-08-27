import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "./pglite.js";

describe("harness PGlite", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("chạy được query qua drizzle", async () => {
    const r = await t.db.execute(sql`select 1 as one`);
    expect(r.rows[0]).toEqual({ one: 1 });
  });

  it("là Postgres thật (không phải mock)", async () => {
    const r = await t.db.execute(sql`select version() as v`);
    expect(String(r.rows[0]?.["v"])).toContain("PostgreSQL");
  });

  it("hỗ trợ gen_random_uuid() và jsonb — thứ migration cần", async () => {
    const r = await t.db.execute(sql`select gen_random_uuid() as id, '{"a":1}'::jsonb -> 'a' as a`);
    expect(String(r.rows[0]?.["id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
});
