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

describe("users columns added for internal login", () => {
  it("has the password_hash/status/email_verified_at/last_login_at columns", async () => {
    const r = await t.db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY column_name`);
    const cols = new Map(r.rows.map((x) => [String(x["column_name"]), String(x["is_nullable"])]));
    for (const c of ["password_hash", "status", "email_verified_at", "last_login_at", "updated_at"]) {
      expect([...cols.keys()], `missing column ${c}`).toContain(c);
    }
    // An account that only logs in via OIDC has NO password.
    expect(cols.get("password_hash")).toBe("YES");
  });

  it("user_status is an enum of active/suspended/deactivated", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'user_status' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["active", "suspended", "deactivated"]);
  });

  it("email is unique and case-insensitive", async () => {
    await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('QA@Acme.test','A')`);
    // drizzle-orm 0.45 WRAPS the driver error: `message` is just "Failed query: ..." while
    // the real Postgres message (SQLSTATE + constraint name) lives in `cause` — same
    // convention as M1's test/schema/tenancy.test.ts, tighter than a regex on message.
    const err: unknown = await t.db
      .execute(sql`INSERT INTO users (email, display_name) VALUES ('qa@acme.test','B')`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const cause = (
      err as { readonly cause?: { code?: string; constraint?: string; message?: string } } | undefined
    )?.cause;
    expect(cause?.code).toBe("23505"); // unique_violation
    expect(cause?.constraint).toBe("users_email_lower_uidx");
    expect(cause?.message).toMatch(/duplicate key|unique/i);
  });

  it("users does NOT have RLS enabled (globally) — protection is L1 + GRANT, not policy", async () => {
    const r = await t.db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname='users' AND relkind='r'`);
    expect(r.rows[0]?.["relrowsecurity"]).toBe(false);
  });
});
