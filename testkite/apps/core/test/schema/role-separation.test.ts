/**
 * DB role separation — the DEPLOYMENT half of tenant isolation.
 *
 * A separation test that only ever runs on a clean cluster proves the cluster is clean, not
 * that the test can see dirt. Every case here CREATES the violation it is about, asserts the
 * checker names it, and drops it again.
 *
 * REAL POSTGRES ONLY: roles are cluster-wide objects, and the shapes that matter (a two-hop
 * grant, `WITH INHERIT FALSE`, a login role at all, a second connection authenticating as that
 * login) do not exist in the single-connection PGlite harness. `describeRealPg` skips on a dev
 * box without Postgres; the db-tests job sets TESTKITE_REQUIRE_PG=1 so a skip there is a throw.
 *
 * PROBE ROLES are prefixed `tk_sep_` and dropped in afterEach — a leaked role would make the
 * NEXT run of this file fail for the wrong reason, on a shared cluster. `probeIdent` refuses
 * any other name, so no statement built here can reach a role the deployment cares about.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  APP_ROLE,
  AUTH_ROLE,
  DISPATCH_ROLE,
  RELAY_ROLE,
  TESTKITE_SUB_ROLES,
  roleSeparationViolations,
  type RoleSeparationViolation,
} from "../../src/modules/kernel/index.js";
import { describeRealPg, makeRealDb, realPgUrl, type RealDb } from "../harness/realpg.js";

/** Every probe role shares one password: the cluster is disposable and the value is public. */
const PROBE_PASSWORD = "tk_sep_probe";

/**
 * Probe roles are created and DROPPED by this file, so the name is the whole safety boundary.
 * Anything that is not `tk_sep_<lowercase>` throws instead of reaching a real role.
 */
function probeIdent(name: string): string {
  if (!/^tk_sep_[a-z0-9_]+$/.test(name)) {
    throw new Error(`probe role names must match tk_sep_[a-z0-9_]+, got: ${name}`);
  }
  return `"${name}"`;
}

/** The four deployment roles are compile-time constants of this repo, never user input. */
function subRoleIdent(name: string): string {
  if (!TESTKITE_SUB_ROLES.some((r) => r === name)) {
    throw new Error(`not a testkite sub-role: ${name}`);
  }
  return `"${name}"`;
}

interface ProbeSpec {
  readonly login: boolean;
  /** The role-level attribute. PostgreSQL 16+ only uses it as the DEFAULT for future grants. */
  readonly inherit: boolean;
  readonly bypassrls?: boolean;
  /** testkite_* roles granted to the probe, in one GRANT after the role exists. */
  readonly subRoles?: readonly string[];
  /** Other probe roles granted to the probe — how a two-hop violation is built. */
  readonly viaProbes?: readonly string[];
}

let r: RealDb;
let teamA = "";
let teamB = "";

/** Names created by the current test, dropped in afterEach in reverse order of creation. */
const created: string[] = [];

async function createProbe(name: string, spec: ProbeSpec): Promise<void> {
  const ident = probeIdent(name);
  const attrs = [
    spec.login ? "LOGIN" : "NOLOGIN",
    spec.inherit ? "INHERIT" : "NOINHERIT",
    spec.bypassrls === true ? "BYPASSRLS" : "NOBYPASSRLS",
    `PASSWORD '${PROBE_PASSWORD}'`,
  ].join(" ");
  await r.db.execute(sql.raw(`CREATE ROLE ${ident} ${attrs}`));
  created.push(name);
  const granted = [
    ...(spec.subRoles ?? []).map(subRoleIdent),
    ...(spec.viaProbes ?? []).map(probeIdent),
  ];
  if (granted.length > 0) {
    await r.db.execute(sql.raw(`GRANT ${granted.join(", ")} TO ${ident}`));
  }
}

async function grantWithInheritFalse(name: string, subRoles: readonly string[]): Promise<void> {
  const list = subRoles.map(subRoleIdent).join(", ");
  await r.db.execute(sql.raw(`GRANT ${list} TO ${probeIdent(name)} WITH INHERIT FALSE`));
}

async function violations(): Promise<readonly RoleSeparationViolation[]> {
  return roleSeparationViolations(r.db);
}

function forRole(
  list: readonly RoleSeparationViolation[],
  role: string,
): readonly RoleSeparationViolation[] {
  return list.filter((v) => v.role === role);
}

/** A connection that authenticates AS a probe login — the only way to observe what it can read. */
function probeUrl(role: string): string {
  const base = realPgUrl();
  if (base === undefined) throw new Error("TESTKITE_TEST_PG_URL is not set");
  const url = new URL(base);
  url.username = role;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

interface ReadAs {
  /** `SET ROLE` to this testkite role first — the request path. Omitted = the forgotten path. */
  readonly setRole?: string;
  /** `app.team_id`, the GUC `tenant_isolation` reads. */
  readonly teamId?: string;
}

/**
 * Distinct `job_runs.team_id` visible to `role`. Returns the teams, or throws the Postgres
 * error verbatim — "permission denied for table job_runs" IS the desired answer for a login
 * that forgot to SET ROLE, so the test has to be able to see it.
 */
async function jobRunTeamsAs(role: string, opts: ReadAs = {}): Promise<readonly string[]> {
  const client = new pg.Client({ connectionString: probeUrl(role) });
  await client.connect();
  try {
    // Compile-time constants of this repo (APP_ROLE / DISPATCH_ROLE), never user input.
    if (opts.setRole !== undefined) await client.query(`SET ROLE ${subRoleIdent(opts.setRole)}`);
    if (opts.teamId !== undefined) {
      await client.query("SELECT set_config('app.team_id', $1, false)", [opts.teamId]);
    }
    const res = await client.query<{ team_id: string }>(
      "SELECT DISTINCT team_id FROM job_runs ORDER BY team_id",
    );
    return res.rows.map((row) => row.team_id);
  } finally {
    await client.end();
  }
}

/** The check `job-runs-schema.test.ts` makes today: ONE edge, no closure. */
async function directEdgeCount(member: string, granted: string): Promise<number> {
  const res = await r.db.execute(sql`
    SELECT count(*)::int AS n FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid = m.roleid
    JOIN pg_roles member  ON member.oid  = m.member
    WHERE granted.rolname = ${granted} AND member.rolname = ${member}`);
  return Number(res.rows[0]?.["n"]);
}

async function errorMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: unknown) {
    const parts: string[] = [];
    let cur: unknown = err;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    return parts.join(" | ");
  }
  throw new Error("the statement was expected to be rejected, but it succeeded");
}

describeRealPg("DB role separation", () => {
  beforeAll(async () => {
    r = await makeRealDb();
    await r.db.execute(sql`
      TRUNCATE res_step_results, res_case_results, res_case_result_keys, job_runs, orc_run_plans,
               orc_compile_diagnostics, orc_runs, quota_limits, memberships, projects,
               teams, users, organizations
      RESTART IDENTITY CASCADE`);
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const rows = await r.db.execute(query);
      const id: unknown = rows.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("seed: INSERT returned no id");
      return id;
    };
    const orgId = await one(
      sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`,
    );
    const userId = await one(
      sql`INSERT INTO users (email, display_name) VALUES ('a@testkite.test','A') RETURNING id`,
    );
    for (const slug of ["a", "b"]) {
      const teamId = await one(
        sql`INSERT INTO teams (org_id, name, slug) VALUES (${orgId}, ${slug}, ${slug}) RETURNING id`,
      );
      const projectId = await one(
        sql`INSERT INTO projects (team_id, name, slug) VALUES (${teamId},'P','p') RETURNING id`,
      );
      const runId = await one(sql`
        INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
        VALUES (${teamId}, ${projectId}, 'batch', ${userId}, 'ready') RETURNING id`);
      await r.db.execute(sql`
        INSERT INTO job_runs (team_id, run_id, chain_key) VALUES (${teamId}, ${runId}, 'login')`);
      if (slug === "a") teamA = teamId;
      else teamB = teamId;
    }
  });

  afterAll(async () => {
    await r.close();
  });

  afterEach(async () => {
    for (const name of [...created].reverse()) {
      await r.db.execute(sql.raw(`DROP ROLE IF EXISTS ${probeIdent(name)}`));
    }
    created.length = 0;
  });

  it("PROVES the hole it guards: an INHERIT login holding app + dispatch reads across teams", async () => {
    // Not an article of faith. job_runs carries two PERMISSIVE policies — tenant_isolation
    // (TO testkite_app) and dispatch_all (TO testkite_dispatch, USING true) — and permissive
    // policies OR. Measured 2026-08-31: both teams, with app.team_id pinned to team A.
    await createProbe("tk_sep_inherit", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE, DISPATCH_ROLE],
    });
    const seen = await jobRunTeamsAs("tk_sep_inherit", { teamId: teamA });
    expect([...seen].sort()).toEqual([teamA, teamB].sort());
  });

  it("PROVES `ALTER ROLE ... NOINHERIT` does NOT close it once the grants already exist", async () => {
    // PostgreSQL 16 moved inheritance onto the GRANT (pg_auth_members.inherit_option); the
    // role-level attribute is only the default for FUTURE grants. Measured 2026-08-31: this
    // login reports rolinherit = false and still reads every team. The remediation an operator
    // reaches for first is therefore a NO-OP, which is exactly why the checker must not believe
    // rolinherit.
    await createProbe("tk_sep_stale", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE, DISPATCH_ROLE],
    });
    await r.db.execute(sql.raw(`ALTER ROLE ${probeIdent("tk_sep_stale")} NOINHERIT`));
    const attr = await r.db.execute(
      sql`SELECT rolinherit FROM pg_roles WHERE rolname = 'tk_sep_stale'`,
    );
    expect(attr.rows[0]?.["rolinherit"]).toBe(false);
    const seen = await jobRunTeamsAs("tk_sep_stale", { teamId: teamA });
    expect([...seen].sort()).toEqual([teamA, teamB].sort());
  });

  it("PROVES a login holding only testkite_app stays inside its tenant, and cannot reach dispatch", async () => {
    // The first row of the runbook's truth table: one role is not yet a hole, because there is
    // no second permissive policy to OR with. It is still reported by INV-1 — see the checker's
    // note — but the leak needs the second membership, and this is what "not yet" looks like.
    await createProbe("tk_sep_apponly", { login: true, inherit: true, subRoles: [APP_ROLE] });
    expect(await jobRunTeamsAs("tk_sep_apponly", { teamId: teamA })).toEqual([teamA]);
    expect(await jobRunTeamsAs("tk_sep_apponly", { setRole: APP_ROLE, teamId: teamA })).toEqual([
      teamA,
    ]);
    const denied = await errorMessage(() =>
      jobRunTeamsAs("tk_sep_apponly", { setRole: DISPATCH_ROLE }),
    );
    expect(denied).toMatch(/permission denied to set role/i);
  });

  it("PROVES INV-2 is worse than INV-1: a sub-role membership leaks THROUGH a correct SET ROLE", async () => {
    // The last row of the runbook's truth table, and the reason INV-2 ignores inherit_option
    // entirely: the login here does everything right — it inherits nothing and it SET ROLEs to
    // testkite_app — and still reads both teams, because testkite_app itself now carries
    // testkite_dispatch's permissive policy.
    await createProbe("tk_sep_correct", { login: true, inherit: false, subRoles: [APP_ROLE] });
    expect(await jobRunTeamsAs("tk_sep_correct", { setRole: APP_ROLE, teamId: teamA })).toEqual([
      teamA,
    ]);
    await r.db.execute(
      sql.raw(`GRANT ${subRoleIdent(DISPATCH_ROLE)} TO ${subRoleIdent(APP_ROLE)}`),
    );
    try {
      const seen = await jobRunTeamsAs("tk_sep_correct", { setRole: APP_ROLE, teamId: teamA });
      expect([...seen].sort()).toEqual([teamA, teamB].sort());
    } finally {
      await r.db.execute(
        sql.raw(`REVOKE ${subRoleIdent(DISPATCH_ROLE)} FROM ${subRoleIdent(APP_ROLE)}`),
      );
    }
  });

  it("PROVES the shape production must use: NOINHERIT at grant time fails closed, SET ROLE still works", async () => {
    await createProbe("tk_sep_ok", {
      login: true,
      inherit: false,
      subRoles: [...TESTKITE_SUB_ROLES],
    });
    const forgotten = await errorMessage(() =>
      jobRunTeamsAs("tk_sep_ok", { teamId: teamA }),
    );
    expect(forgotten).toMatch(/permission denied for table job_runs/i);
    expect(await jobRunTeamsAs("tk_sep_ok", { setRole: APP_ROLE, teamId: teamA })).toEqual([teamA]);
    const dispatch = await jobRunTeamsAs("tk_sep_ok", { setRole: DISPATCH_ROLE });
    expect([...dispatch].sort()).toEqual([teamA, teamB].sort());
  });

  it("CATCHES that same INHERIT login (INV-1)", async () => {
    await createProbe("tk_sep_inherit", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE, DISPATCH_ROLE],
    });
    expect(await violations()).toContainEqual(
      expect.objectContaining({ kind: "inheriting_login", role: "tk_sep_inherit" }),
    );
  });

  it("CATCHES the login whose grants predate `ALTER ROLE ... NOINHERIT` (INV-1)", async () => {
    // The case a rolinherit-based check waves through. See the PROVES test above.
    await createProbe("tk_sep_stale", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE, DISPATCH_ROLE],
    });
    await r.db.execute(sql.raw(`ALTER ROLE ${probeIdent("tk_sep_stale")} NOINHERIT`));
    expect(await violations()).toContainEqual(
      expect.objectContaining({ kind: "inheriting_login", role: "tk_sep_stale" }),
    );
  });

  it("CATCHES it through an intermediate role — two hops, which the direct-edge check misses", async () => {
    await createProbe("tk_sep_mid", { login: false, inherit: true, subRoles: [DISPATCH_ROLE] });
    await createProbe("tk_sep_two_hop", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE],
      viaProbes: ["tk_sep_mid"],
    });
    expect(await directEdgeCount("tk_sep_two_hop", DISPATCH_ROLE)).toBe(0);
    const found = forRole(await violations(), "tk_sep_two_hop");
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("inheriting_login");
    expect([...(found[0]?.holds ?? [])].sort()).toEqual([APP_ROLE, DISPATCH_ROLE].sort());
  });

  it("does NOT blame the intermediate role, which cannot log in", async () => {
    await createProbe("tk_sep_mid", { login: false, inherit: true, subRoles: [DISPATCH_ROLE] });
    await createProbe("tk_sep_two_hop", {
      login: true,
      inherit: true,
      viaProbes: ["tk_sep_mid"],
    });
    expect(forRole(await violations(), "tk_sep_mid")).toEqual([]);
  });

  it("ACCEPTS a NOINHERIT login that is a member of all four — the ONLY shape this code runs in", async () => {
    // apps/core has ONE DATABASE_URL and SET LOCAL ROLEs to app / auth / dispatch
    // (kernel/db/tenant.ts). Forbidding the membership would forbid the product.
    await createProbe("tk_sep_ok", {
      login: true,
      inherit: false,
      subRoles: [...TESTKITE_SUB_ROLES],
    });
    expect(forRole(await violations(), "tk_sep_ok")).toEqual([]);
  });

  it("ACCEPTS per-membership WITH INHERIT FALSE as equivalent to NOINHERIT", async () => {
    await createProbe("tk_sep_edge", { login: true, inherit: true });
    await grantWithInheritFalse("tk_sep_edge", [APP_ROLE, DISPATCH_ROLE]);
    expect(forRole(await violations(), "tk_sep_edge")).toEqual([]);
  });

  it("ACCEPTS a two-hop path blocked at EITHER hop, and catches the one blocked at neither", async () => {
    // A path leaks only when EVERY edge on it inherits — measured 2026-08-31 on the privilege
    // itself, not on the catalog.
    await createProbe("tk_sep_mid", { login: false, inherit: true, subRoles: [DISPATCH_ROLE] });
    await createProbe("tk_sep_midblocked", { login: false, inherit: true });
    await grantWithInheritFalse("tk_sep_midblocked", [DISPATCH_ROLE]);
    await createProbe("tk_sep_hop1blocked", { login: true, inherit: true });
    await r.db.execute(
      sql.raw(
        `GRANT ${probeIdent("tk_sep_mid")} TO ${probeIdent("tk_sep_hop1blocked")} WITH INHERIT FALSE`,
      ),
    );
    await createProbe("tk_sep_hop2blocked", {
      login: true,
      inherit: true,
      viaProbes: ["tk_sep_midblocked"],
    });
    await createProbe("tk_sep_open", { login: true, inherit: true, viaProbes: ["tk_sep_mid"] });
    const found = await violations();
    expect(forRole(found, "tk_sep_hop1blocked")).toEqual([]);
    expect(forRole(found, "tk_sep_hop2blocked")).toEqual([]);
    expect(forRole(found, "tk_sep_open")).toHaveLength(1);
  });

  it("CATCHES a login that inherits a testkite role by ONE of two paths", async () => {
    // bool_and over paths, not over edges: one blocked path does not excuse an open one.
    await createProbe("tk_sep_mid", { login: false, inherit: true, subRoles: [DISPATCH_ROLE] });
    await createProbe("tk_sep_both", { login: true, inherit: true, viaProbes: ["tk_sep_mid"] });
    await grantWithInheritFalse("tk_sep_both", [DISPATCH_ROLE]);
    expect(await violations()).toContainEqual(
      expect.objectContaining({ kind: "inheriting_login", role: "tk_sep_both" }),
    );
  });

  it("CATCHES a sub-role that is a member of another sub-role (INV-2)", async () => {
    // This one is worse than INV-1: it leaks THROUGH a correct SET ROLE.
    await r.db.execute(
      sql.raw(`GRANT ${subRoleIdent(DISPATCH_ROLE)} TO ${subRoleIdent(APP_ROLE)}`),
    );
    try {
      expect(await violations()).toContainEqual(
        expect.objectContaining({ kind: "sub_role_membership", role: APP_ROLE }),
      );
    } finally {
      await r.db.execute(
        sql.raw(`REVOKE ${subRoleIdent(DISPATCH_ROLE)} FROM ${subRoleIdent(APP_ROLE)}`),
      );
    }
  });

  it("CATCHES a sub-role membership even when the grant says INHERIT FALSE (INV-2)", async () => {
    // SET ROLE is still allowed, so the union is still reachable; the edge must not exist at all.
    await r.db.execute(
      sql.raw(
        `GRANT ${subRoleIdent(AUTH_ROLE)} TO ${subRoleIdent(RELAY_ROLE)} WITH INHERIT FALSE`,
      ),
    );
    try {
      expect(await violations()).toContainEqual(
        expect.objectContaining({ kind: "sub_role_membership", role: RELAY_ROLE }),
      );
    } finally {
      await r.db.execute(
        sql.raw(`REVOKE ${subRoleIdent(AUTH_ROLE)} FROM ${subRoleIdent(RELAY_ROLE)}`),
      );
    }
  });

  it("CATCHES a login that is BYPASSRLS while holding a testkite role (INV-3)", async () => {
    await createProbe("tk_sep_bypass", {
      login: true,
      inherit: false,
      bypassrls: true,
      subRoles: [APP_ROLE],
    });
    const found = forRole(await violations(), "tk_sep_bypass");
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("privileged_login");
  });

  it("names a fix an operator can run, and it is not the one that does nothing", async () => {
    await createProbe("tk_sep_inherit", {
      login: true,
      inherit: true,
      subRoles: [APP_ROLE, DISPATCH_ROLE],
    });
    const found = forRole(await violations(), "tk_sep_inherit");
    expect(found[0]?.detail).toContain("WITH INHERIT FALSE");
  });

  it("reports NOTHING once every probe role is gone", async () => {
    // The positive control, and it comes LAST on purpose: it is only meaningful after the cases
    // above have shown the checker can see something.
    //
    // HONEST SCOPE: on CI this asserts that the migrations alone create no violation. It says
    // NOTHING about the production cluster — CI's own login is the superuser `postgres`, which
    // this checker excludes from INV-1/INV-3 (it holds no testkite_* role) and which production
    // must never use. The production truth is established by running scripts/grant-db-roles.sql
    // in check mode against that cluster; see docs/runbook-db-roles.md.
    expect(await violations()).toEqual([]);
  });
});
