/**
 * HTTP harness: a migrated PGlite + 2 teams + every kind of user/token + a real Fastify app.
 * Used by auth tests (Task 6), onboarding (Task 10), and the L3 isolation suite (Task 11).
 */
import { sql } from "drizzle-orm";
import { makeTestDb, PENDING_LOCATOR_ELEMENT_ID, type TestDb } from "./pglite.js";
import { buildHttpApp, type TkApp } from "../../src/http/app.js";
import {
  createAuthenticator,
  createAuthzCache,
  mintTokenSecret,
} from "../../src/modules/identity/index.js";
import { identityRouteRegistrations } from "../../src/modules/identity/routes.js";
import { writeAuditEvent } from "../../src/modules/governance/index.js";
import { governanceRouteRegistrations } from "../../src/modules/governance/routes.js";
import { authoringRoutes } from "../../src/modules/authoring/index.js";
import { orchestrationRoutes } from "../../src/modules/orchestration/index.js";
import { onboardRouteRegistration } from "../../src/http/usecases/onboard-team.js";
import type { ElementDto } from "@testkite/contract";

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
    /** org_admin role on team A — the ONLY role (alongside instance_operator) that can create a new team. */
    orgAdminA: string;
  };
  readonly counters: { authLookups: number; reset: () => void };
  /** Wait for every `defer`red task (failed-login audit) to finish — see the note below. */
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

/**
 * Phase 0 takes both loaders as injection ports (elements and testdata only land in M4), so the
 * harness decides what an element looks like. The id is what decides the answer: the one
 * `seedCaseWithPendingLocator` uses comes back with no locator — which is what makes the
 * compiler stop with `element_pending_locator` — and everything else comes back ready.
 */
const COMPILE_DEPS = {
  loadElements: async (ids: readonly string[]): Promise<Record<string, ElementDto>> =>
    Object.fromEntries(
      ids.map((id): readonly [string, ElementDto] => [
        id,
        id === PENDING_LOCATOR_ELEMENT_ID
          ? { id, name: "checkout button", status: "pending_locator" as const, locators: [] }
          : {
              id,
              name: `element ${id}`,
              status: "ready" as const,
              locators: [{ kind: "css" as const, value: `#${id}` }],
            },
      ]),
    ),
  loadDataProfiles: async (): Promise<Record<string, never>> => ({}),
};

/** Postgres array literal for text[] — PGlite can't infer the type from a bare JS array. */
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
   * Login's `defer` hook: production fires the task with setImmediate and forgets it (a
   * FAILED login's audit must not sit on the response path — that's a timing side-channel
   * for probing accounts). The harness fires it the exact same way but remembers the promise,
   * because "forgetting" in a test means the audit line lands in the middle of a different test.
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
      // Audit hook injected from the shell layer — exactly like the real composition-root, so tests go through
      // the actual production wiring instead of a harness-only variant.
      ...identityRouteRegistrations({ db: db.db, cache, audit: writeAuditEvent, defer }),
      ...governanceRouteRegistrations({ db: db.db }),
      // Onboarding is submitted from the shell layer (it composes four modules) — exactly like the real composition-root.
      onboardRouteRegistration({ db: db.db }),
    ],
    // Authoring is a plugin (same as composition-root); the L3 suite drives its
    // routes through the real auth hook to prove cross-tenant ids yield 404.
    plugins: [authoringRoutes(db.db), orchestrationRoutes(db.db, { compile: COMPILE_DEPS })],
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
    // The PREVIOUS test's deferred work must finish before TRUNCATE, or it will sneak
    // an audit line into the middle of a later test.
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
    // Default quota limits, exactly like seedQuotaDefaults() does on the real onboarding path.
    // Without the row a team is "never onboarded" and EVERY run reservation is refused, so
    // `POST /v1/runs` would answer 429 for a reason that has nothing to do with the test.
    for (const teamId of [ids.teamA, ids.teamB]) {
      await db.db.execute(sql`INSERT INTO quota_limits (team_id) VALUES (${teamId})`);
    }

    // case:write + case:promote let the L3 suite reach the authoring handlers (and get
    // 404 for a cross-tenant id) instead of stopping at the scope gate; team_admin's
    // role grants both, so the effective scope set is unchanged in kind.
    const ADMIN = [
      "case:read",
      "case:write",
      "case:promote",
      // The three run scopes team_admin's role really carries: without them the L3 probe of
      // /v1/runs* would stop at the scope gate with 403 and never reach the 404-vs-403 question.
      "run:read",
      "run:trigger",
      "run:abort",
      "member:manage",
      "token:issue:user",
      "audit:read",
      "team:manage",
    ];
    const AUTHOR = ["case:read", "case:write", "run:read", "run:trigger", "run:abort"];
    // org_admin: manages people + creates teams, does NOT read team assets (only break-glass reads).
    const ORG_ADMIN = ["member:manage", "audit:read", "team:manage", "team:create"];
    tokens.adminA = await issue(ids.teamA, ids.adminUser, ADMIN, { days: 30 });
    tokens.orgAdminA = await issue(ids.teamA, ids.orgAdminUser, ORG_ADMIN, { days: 30 });
    tokens.authorA = await issue(ids.teamA, ids.authorUser, AUTHOR, { days: 30 });
    tokens.authorAOverreach = await issue(ids.teamA, ids.authorUser, [...AUTHOR, "member:manage"], {
      days: 30,
    });
    tokens.revokedA = await issue(ids.teamA, ids.authorUser, AUTHOR, { days: 30, revoked: true });
    tokens.adminB = await issue(ids.teamB, ids.adminUser, ADMIN, { days: 30 });
    // An already-expired token: expires_at in the past (written directly, not via issue()).
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
