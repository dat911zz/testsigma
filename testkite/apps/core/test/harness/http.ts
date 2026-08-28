/**
 * Harness HTTP: PGlite đã migrate + 2 team + user/token đủ loại + app Fastify thật.
 * Dùng cho test auth (Task 6), onboarding (Task 10) và bộ cách ly L3 (Task 11).
 */
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "./pglite.js";
import { buildHttpApp, type TkApp } from "../../src/http/app.js";
import {
  createAuthenticator,
  createAuthzCache,
  mintTokenSecret,
} from "../../src/modules/identity/index.js";
import { identityRouteRegistrations } from "../../src/modules/identity/routes.js";
import { writeAuditEvent } from "../../src/modules/governance/index.js";
import { governanceRouteRegistrations } from "../../src/modules/governance/routes.js";

export type TestApp = {
  readonly app: TkApp;
  readonly db: TestDb;
  readonly ids: {
    orgId: string;
    teamA: string;
    teamB: string;
    projectA: string;
    projectB: string;
    adminUser: string;
    authorUser: string;
  };
  readonly tokens: {
    adminA: string;
    authorA: string;
    authorAOverreach: string;
    expiredA: string;
    revokedA: string;
    adminB: string;
  };
  readonly counters: { authLookups: number; reset: () => void };
  readonly seed: () => Promise<void>;
  readonly demoteAdminToViewer: () => Promise<void>;
  readonly close: () => Promise<void>;
};

const ENV = {
  NODE_ENV: "test" as const,
  PORT: 8080,
  DATABASE_URL: "postgres://tk:pw@localhost:5432/testkite",
  DATABASE_APP_ROLE: "testkite_app",
  DATABASE_POOL_MAX: 10,
  LOG_LEVEL: "error" as const,
};

/** Postgres array literal cho text[] — PGlite không suy được kiểu từ mảng JS trần. */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
}

export async function makeTestApp(): Promise<TestApp> {
  const db = await makeTestDb();
  const counters = {
    authLookups: 0,
    reset(): void {
      counters.authLookups = 0;
    },
  };
  const cache = createAuthzCache({});
  const authenticator = createAuthenticator({
    db: db.db,
    cache,
    onLookup: () => {
      counters.authLookups += 1;
    },
  });
  const app = await buildHttpApp({
    env: ENV,
    db: db.db,
    authenticator,
    registrations: [
      // Cổng audit tiêm từ tầng shell — y hệt composition-root thật, để test đi qua
      // đúng đường dây sản xuất chứ không phải một biến thể riêng của harness.
      ...identityRouteRegistrations({ db: db.db, cache, audit: writeAuditEvent }),
      ...governanceRouteRegistrations({ db: db.db }),
    ],
  });
  await app.ready();

  const ids = {
    orgId: "",
    teamA: "",
    teamB: "",
    projectA: "",
    projectB: "",
    adminUser: "",
    authorUser: "",
  };
  const tokens = {
    adminA: "",
    authorA: "",
    authorAOverreach: "",
    expiredA: "",
    revokedA: "",
    adminB: "",
  };

  async function issue(
    teamId: string,
    userId: string,
    scopes: readonly string[],
    opts: { days: number; revoked?: boolean },
  ): Promise<string> {
    const m = mintTokenSecret();
    await db.raw.query(
      `INSERT INTO api_tokens (team_id, name, prefix, token_hash, kind, user_id, scopes, expires_at, revoked_at)
       VALUES ($1,'t',$2,$3,'user_pat',$4,$5::text[], now() + ($6 || ' days')::interval, $7)`,
      [
        teamId,
        m.prefix,
        m.tokenHash,
        userId,
        pgTextArray(scopes),
        String(opts.days),
        opts.revoked === true ? new Date() : null,
      ],
    );
    return m.secret;
  }

  async function seed(): Promise<void> {
    await db.reset();
    cache.invalidateTeam(ids.teamA);
    cache.invalidateTeam(ids.teamB);
    const org = await db.db.execute(
      sql`INSERT INTO organizations (name,slug) VALUES ('Acme','acme') RETURNING id`,
    );
    ids.orgId = String(org.rows[0]?.["id"]);
    for (const [key, name] of [
      ["teamA", "A"],
      ["teamB", "B"],
    ] as const) {
      const t = await db.db.execute(
        sql`INSERT INTO teams (org_id,name,slug) VALUES (${ids.orgId},${name},${name.toLowerCase()}) RETURNING id`,
      );
      ids[key] = String(t.rows[0]?.["id"]);
    }
    const pa = await db.db.execute(
      sql`INSERT INTO projects (team_id,name,slug) VALUES (${ids.teamA},'PA','pa') RETURNING id`,
    );
    const pb = await db.db.execute(
      sql`INSERT INTO projects (team_id,name,slug) VALUES (${ids.teamB},'PB','pb') RETURNING id`,
    );
    ids.projectA = String(pa.rows[0]?.["id"]);
    ids.projectB = String(pb.rows[0]?.["id"]);
    const ua = await db.db.execute(
      sql`INSERT INTO users (email,display_name) VALUES ('admin@acme.test','Admin') RETURNING id`,
    );
    const ub = await db.db.execute(
      sql`INSERT INTO users (email,display_name) VALUES ('author@acme.test','Author') RETURNING id`,
    );
    ids.adminUser = String(ua.rows[0]?.["id"]);
    ids.authorUser = String(ub.rows[0]?.["id"]);
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamA},${ids.adminUser},'team_admin')`,
    );
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamA},${ids.authorUser},'author')`,
    );
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamB},${ids.adminUser},'team_admin')`,
    );

    const ADMIN = ["case:read", "member:manage", "token:issue:user", "audit:read", "team:manage"];
    const AUTHOR = ["case:read", "case:write", "run:trigger"];
    tokens.adminA = await issue(ids.teamA, ids.adminUser, ADMIN, { days: 30 });
    tokens.authorA = await issue(ids.teamA, ids.authorUser, AUTHOR, { days: 30 });
    tokens.authorAOverreach = await issue(ids.teamA, ids.authorUser, [...AUTHOR, "member:manage"], {
      days: 30,
    });
    tokens.revokedA = await issue(ids.teamA, ids.authorUser, AUTHOR, { days: 30, revoked: true });
    tokens.adminB = await issue(ids.teamB, ids.adminUser, ADMIN, { days: 30 });
    // Token đã hết hạn: expires_at trong quá khứ (ghi thẳng, không qua issue()).
    const expired = mintTokenSecret();
    await db.raw.query(
      `INSERT INTO api_tokens (team_id,name,prefix,token_hash,kind,user_id,scopes,expires_at)
       VALUES ($1,'expired',$2,$3,'user_pat',$4,$5::text[], now() - interval '1 day')`,
      [ids.teamA, expired.prefix, expired.tokenHash, ids.authorUser, pgTextArray(AUTHOR)],
    );
    tokens.expiredA = expired.secret;
  }

  await seed();

  return {
    app,
    db,
    ids,
    tokens,
    counters,
    seed,
    demoteAdminToViewer: async () => {
      await db.raw.query(`UPDATE memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2`, [
        ids.teamA,
        ids.adminUser,
      ]);
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
