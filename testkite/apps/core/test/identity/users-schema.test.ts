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

describe("users mở rộng cho đăng nhập nội bộ", () => {
  it("có đủ cột password_hash/status/email_verified_at/last_login_at", async () => {
    const r = await t.db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY column_name`);
    const cols = new Map(r.rows.map((x) => [String(x["column_name"]), String(x["is_nullable"])]));
    for (const c of ["password_hash", "status", "email_verified_at", "last_login_at", "updated_at"]) {
      expect([...cols.keys()], `thiếu cột ${c}`).toContain(c);
    }
    // Tài khoản chỉ đăng nhập bằng OIDC thì KHÔNG có mật khẩu.
    expect(cols.get("password_hash")).toBe("YES");
  });

  it("user_status là enum active/suspended/deactivated", async () => {
    const r = await t.db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'user_status' ORDER BY e.enumsortorder`);
    expect(r.rows.map((x) => x["enumlabel"])).toEqual(["active", "suspended", "deactivated"]);
  });

  it("email là duy nhất và không phân biệt hoa thường", async () => {
    await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('QA@Acme.test','A')`);
    // drizzle-orm 0.45 BỌC lỗi driver: `message` chỉ là "Failed query: ..." còn
    // thông điệp Postgres thật (SQLSTATE + tên constraint) nằm ở `cause` — cùng
    // quy ước với test/schema/tenancy.test.ts của M1, chặt hơn regex trên message.
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

  it("users KHÔNG bật RLS (toàn cục) — bảo vệ ở L1 + GRANT, không phải policy", async () => {
    const r = await t.db.execute(sql`SELECT relrowsecurity FROM pg_class WHERE relname='users' AND relkind='r'`);
    expect(r.rows[0]?.["relrowsecurity"]).toBe(false);
  });
});
