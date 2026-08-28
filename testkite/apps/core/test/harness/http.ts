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
import { onboardRouteRegistration } from "../../src/http/usecases/onboard-team.js";

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
    orgAdminUser: string;
  };
  readonly tokens: {
    adminA: string;
    authorA: string;
    authorAOverreach: string;
    expiredA: string;
    revokedA: string;
    adminB: string;
    /** Vai org_admin ở team A — vai DUY NHẤT (cùng instance_operator) tạo được team mới. */
    orgAdminA: string;
  };
  readonly counters: { authLookups: number; reset: () => void };
  /** Đợi mọi việc `defer` (audit đăng nhập hỏng) chạy xong — xem ghi chú ở dưới. */
  readonly settleDeferred: () => Promise<void>;
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
  /**
   * Cổng `defer` của login: sản phẩm bắn task bằng setImmediate rồi quên (audit của
   * lần đăng nhập HỎNG không được nằm trên đường phản hồi — kênh dò tài khoản qua
   * timing). Harness giữ y hệt cách bắn ấy nhưng nhớ promise lại, vì "quên" trong
   * test nghĩa là dòng audit rơi vào giữa một test khác.
   */
  let deferred: Promise<void>[] = [];
  const defer = (task: () => Promise<void>): void => {
    deferred.push(
      new Promise<void>((resolve) => {
        setImmediate(() => {
          void task()
            .catch(() => undefined)
            .then(() => {
              resolve();
            });
        });
      }),
    );
  };
  const settleDeferred = async (): Promise<void> => {
    while (deferred.length > 0) {
      const batch = deferred;
      deferred = [];
      await Promise.all(batch);
    }
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
      ...identityRouteRegistrations({ db: db.db, cache, audit: writeAuditEvent, defer }),
      ...governanceRouteRegistrations({ db: db.db }),
      // Onboarding nộp từ tầng shell (nó ghép bốn module) — y hệt composition-root thật.
      onboardRouteRegistration({ db: db.db }),
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
    orgAdminUser: "",
  };
  const tokens = {
    adminA: "",
    authorA: "",
    authorAOverreach: "",
    expiredA: "",
    revokedA: "",
    adminB: "",
    orgAdminA: "",
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
    // Việc hoãn của test TRƯỚC phải xong trước khi TRUNCATE, nếu không nó ghi lén một
    // dòng audit vào giữa test sau.
    await settleDeferred();
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
    const uo = await db.db.execute(
      sql`INSERT INTO users (email,display_name) VALUES ('orgadmin@acme.test','OrgAdmin') RETURNING id`,
    );
    ids.adminUser = String(ua.rows[0]?.["id"]);
    ids.authorUser = String(ub.rows[0]?.["id"]);
    ids.orgAdminUser = String(uo.rows[0]?.["id"]);
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamA},${ids.adminUser},'team_admin')`,
    );
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamA},${ids.authorUser},'author')`,
    );
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamB},${ids.adminUser},'team_admin')`,
    );
    await db.db.execute(
      sql`INSERT INTO memberships (team_id,user_id,role) VALUES (${ids.teamA},${ids.orgAdminUser},'org_admin')`,
    );

    const ADMIN = ["case:read", "member:manage", "token:issue:user", "audit:read", "team:manage"];
    const AUTHOR = ["case:read", "case:write", "run:trigger"];
    // org_admin: quản người + tạo team, KHÔNG đọc tài sản team (break-glass mới đọc).
    const ORG_ADMIN = ["member:manage", "audit:read", "team:manage", "team:create"];
    tokens.adminA = await issue(ids.teamA, ids.adminUser, ADMIN, { days: 30 });
    tokens.orgAdminA = await issue(ids.teamA, ids.orgAdminUser, ORG_ADMIN, { days: 30 });
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
    settleDeferred,
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
