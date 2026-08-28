/**
 * Lệch có chủ đích so với plan (Task 7 Step 5 đặt file này ở
 * `src/modules/governance/audit/write.test.ts`): `apps/core/tsconfig.json` khai
 * `rootDir: "src"` + `include: ["src"]`, nên một test nằm trong `src` mà import
 * harness ở `test/harness/pglite.js` làm `pnpm typecheck` đỏ ngay
 * (TS6059 "not under rootDir" + TS6307 "not listed within the file list").
 * Đúng vì thế mọi test CHẠM DB của repo này đều sống dưới `apps/core/test/`;
 * test nằm trong `src` chỉ dành cho unit test thuần. Nội dung test giữ nguyên
 * từng assertion như plan, chỉ đổi vị trí file + đường import.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { withTenant } from "../../src/modules/kernel/index.js";
import { writeAuditEvent } from "../../src/modules/governance/audit/write.js";

let t: TestDb;
let teamA = "";

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
  const a = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'A','a') RETURNING id`,
  );
  teamA = String(a.rows[0]?.["id"]);
});

describe("writeAuditEvent", () => {
  it("ghi được trong cùng transaction với hành động", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await writeAuditEvent(
        tx,
        { teamId: teamA },
        {
          actorKind: "user",
          actorId: null,
          action: "token.issue",
          severity: "HIGH",
          targetKind: "api_token",
          meta: { prefix: "9f3ac21b" },
        },
      );
    });
    const r = await t.db.execute(sql`SELECT action, severity, meta FROM audit_events`);
    expect(r.rows[0]).toMatchObject({ action: "token.issue", severity: "HIGH" });
    expect(r.rows[0]?.["meta"]).toMatchObject({ prefix: "9f3ac21b" });
  });

  it("rollback của hành động cuốn theo cả dòng audit (không audit ma)", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) => {
        await writeAuditEvent(
          tx,
          { teamId: teamA },
          { actorKind: "system", actorId: null, action: "x", severity: "LOW" },
        );
        throw new Error("hành động thất bại");
      }),
    ).rejects.toThrow("hành động thất bại");
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
    expect(Number(r.rows[0]?.["n"])).toBe(0);
  });

  it("từ chối action rỗng và meta quá lớn (audit không phải chỗ đổ log)", async () => {
    await withTenant(t.db, { teamId: teamA }, async (tx) => {
      await expect(
        writeAuditEvent(
          tx,
          { teamId: teamA },
          { actorKind: "system", actorId: null, action: "  ", severity: "LOW" },
        ),
      ).rejects.toThrow(/action/i);
      await expect(
        writeAuditEvent(
          tx,
          { teamId: teamA },
          {
            actorKind: "system",
            actorId: null,
            action: "big",
            severity: "LOW",
            meta: { blob: "x".repeat(40_000) },
          },
        ),
      ).rejects.toThrow(/meta/i);
    });
  });
});
