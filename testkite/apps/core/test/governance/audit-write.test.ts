/**
 * Deliberate deviation from the plan (Task 7 Step 5 put this file at
 * `src/modules/governance/audit/write.test.ts`): `apps/core/tsconfig.json` declares
 * `rootDir: "src"` + `include: ["src"]`, so a test living in `src` that imports the
 * harness at `test/harness/pglite.js` makes `pnpm typecheck` fail immediately
 * (TS6059 "not under rootDir" + TS6307 "not listed within the file list").
 * That's exactly why every test that TOUCHES the DB in this repo lives under
 * `apps/core/test/`; a test living in `src` is for pure unit tests only. The test
 * content keeps every assertion exactly as the plan specified — only the file
 * location + import path changed.
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
  it("writes successfully in the same transaction as the action", async () => {
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

  it("rolling back the action rolls back the audit row too (no ghost audit)", async () => {
    await expect(
      withTenant(t.db, { teamId: teamA }, async (tx) => {
        await writeAuditEvent(
          tx,
          { teamId: teamA },
          { actorKind: "system", actorId: null, action: "x", severity: "LOW" },
        );
        throw new Error("action failed");
      }),
    ).rejects.toThrow("action failed");
    const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events`);
    expect(Number(r.rows[0]?.["n"])).toBe(0);
  });

  it("rejects an empty action and an oversized meta (audit isn't a log dump)", async () => {
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
