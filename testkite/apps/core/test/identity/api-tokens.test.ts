import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { mintTokenSecret } from "../../src/modules/identity/auth/token.js";

let t: TestDb;
let teamA = "";
let teamB = "";
let userId = "";

beforeAll(async () => {
  t = await makeTestDb();
});
afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const a = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  const b = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'B','b') RETURNING id`);
  teamA = String(a.rows[0]?.["id"]);
  teamB = String(b.rows[0]?.["id"]);
  const u = await t.db.execute(sql`INSERT INTO users (email,display_name) VALUES ('qa@acme.test','QA') RETURNING id`);
  userId = String(u.rows[0]?.["id"]);
  await t.db.execute(sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${teamA},${userId},'author')`);
});

async function insertToken(teamId: string, hash: Buffer, prefix: string, expiresInDays = 30): Promise<void> {
  await t.raw.query(
    `INSERT INTO api_tokens (team_id, name, prefix, token_hash, kind, user_id, scopes, expires_at)
     VALUES ($1,'ci',$2,$3,'user_pat',$4,ARRAY['case:read'], now() + ($5 || ' days')::interval)`,
    [teamId, prefix, hash, userId, String(expiresInDays)],
  );
}

describe("api_tokens", () => {
  it("expiry is NOT NULL — an unlimited-lifetime token cannot be created", async () => {
    const r = await t.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name='api_tokens' AND column_name='expires_at'`);
    expect(r.rows[0]?.["is_nullable"]).toBe("NO");
  });

  it("token_hash is globally unique and has a UNIQUE(team_id,id) anchor for the composite FK", async () => {
    const defs = await t.db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE tablename='api_tokens'`);
    const all = defs.rows.map((x) => String(x["indexdef"])).join("\n");
    expect(all).toMatch(/UNIQUE INDEX .*api_tokens_token_hash/);
    expect(all).toMatch(/\(team_id, id\)/);
  });

  it("the secret is NOT stored in any column — only hash and prefix", async () => {
    const cols = await t.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name='api_tokens'`);
    const names = cols.rows.map((x) => String(x["column_name"]));
    expect(names).toContain("token_hash");
    expect(names).toContain("prefix");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("token");
  });

  it("RLS: team B cannot see team A's token", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_app`);
    await t.raw.query(`SELECT set_config('app.team_id', $1, false)`, [teamB]);
    const seen = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_tokens`);
    await t.raw.exec(`RESET ROLE; RESET app.team_id;`);
    expect(seen.rows[0]?.n).toBe(0);
  });

  it("KNOWN DEADLOCK: the app role CANNOT look up a token before the tenant is known", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_app`);
    const r = await t.raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_tokens WHERE token_hash = $1`, [
      m.tokenHash,
    ]);
    await t.raw.exec(`RESET ROLE`);
    expect(r.rows[0]?.n).toBe(0);
  });

  it("the testkite_auth role can look up the token + membership WITHOUT app.team_id set", async () => {
    const m = mintTokenSecret();
    await insertToken(teamA, m.tokenHash, m.prefix);
    await t.raw.exec(`SET ROLE testkite_auth`);
    const tok = await t.raw.query<{ team_id: string }>(
      `SELECT team_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [m.tokenHash],
    );
    const mem = await t.raw.query<{ role: string }>(`SELECT role FROM memberships WHERE user_id = $1`, [userId]);
    await t.raw.exec(`RESET ROLE`);
    expect(tok.rows[0]?.team_id).toBe(teamA);
    expect(mem.rows[0]?.role).toBe("author");
  });

  it("testkite_auth can only READ, and only from an explicit, closed set of tables", async () => {
    // Spot-checking a couple of denied tables (the old shape of this test) only proves
    // those two are blocked — it says nothing about the FULL set testkite_auth can read,
    // so a later migration widening the GRANT would slip past silently. Enumerate the
    // grant catalog instead and match it against a named set: any future GRANT to this
    // role — intentional or not — has to touch this list to stay green.
    // (0016 grants api_tokens/memberships/users; 0019 adds idn_oidc_connectors +
    // idn_oidc_login_states; 0034 adds orc_run_tokens, because a fleet RUN TOKEN is verified
    // on the same pre-tenant auth path as an api_token and hits the same deadlock — 6 tables
    // in total, see the migration comments.)
    const grants = await t.raw.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'testkite_auth' AND table_schema = 'public'
       ORDER BY table_name, privilege_type`,
    );
    const tableNames = [...new Set(grants.rows.map((r) => r.table_name))].sort();
    expect(tableNames).toEqual(
      [
        "api_tokens",
        "idn_oidc_connectors",
        "idn_oidc_login_states",
        "memberships",
        "orc_run_tokens",
        "users",
      ].sort(),
    );
    // Every grant row is SELECT — no INSERT/UPDATE/DELETE snuck in anywhere in the set.
    expect(new Set(grants.rows.map((r) => r.privilege_type))).toEqual(new Set(["SELECT"]));

    // Still prove it's enforced at the engine level, not just declared in the catalog.
    await t.raw.exec(`SET ROLE testkite_auth`);
    await expect(t.raw.query(`UPDATE api_tokens SET revoked_at = now()`)).rejects.toThrow(/permission denied/i);
    await expect(t.raw.query(`SELECT count(*) FROM teams`)).rejects.toThrow(/permission denied/i);
    await expect(t.raw.query(`SELECT count(*) FROM projects`)).rejects.toThrow(/permission denied/i);
    await t.raw.exec(`RESET ROLE`);
  });

  it("testkite_auth is NOT superuser, NOT bypassrls", async () => {
    const r = await t.db.execute(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='testkite_auth'`);
    expect(r.rows[0]?.["rolsuper"]).toBe(false);
    expect(r.rows[0]?.["rolbypassrls"]).toBe(false);
  });
});
