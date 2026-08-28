/**
 * `seedEnvironmentStubs` is idempotent on (team, project, name) and must stay
 * PROJECT-scoped on BOTH of its paths.
 *
 * The insert path is pinned by the unique key, so it cannot drift. The idempotent
 * re-run path is the one worth a test: it reads the environments back instead of
 * inserting, and RLS alone only narrows that read to the TEAM. A team with more than
 * one project therefore gets every project's environments handed back to it — an
 * onboarding replay would answer with ids that belong to a different project.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { withTenant } from "../../src/modules/kernel/index.js";
import { ONBOARD_ENV_NAMES, seedEnvironmentStubs } from "../../src/modules/planning/index.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let teamId = "";
let projectOne = "";
let projectTwo = "";

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
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(
    sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`,
  );
  teamId = String(team.rows[0]?.["id"]);
  const p1 = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'One','one') RETURNING id`,
  );
  const p2 = await t.db.execute(
    sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'Two','two') RETURNING id`,
  );
  projectOne = String(p1.rows[0]?.["id"]);
  projectTwo = String(p2.rows[0]?.["id"]);
});

const seed = async (projectId: string): Promise<readonly string[]> =>
  withTenant(t.db, { teamId }, async (tx) =>
    seedEnvironmentStubs(tx, { teamId }, { projectId, baseUrl: "https://app.acme.test" }),
  );

const envIdsOf = async (projectId: string): Promise<string[]> => {
  const r = await t.db.execute(
    sql`SELECT id FROM pln_environments WHERE project_id = ${projectId} ORDER BY name`,
  );
  return r.rows.map((x) => String(x["id"]));
};

describe("seedEnvironmentStubs", () => {
  it("creates exactly the 3 named stubs for the project it was asked about", async () => {
    const ids = await seed(projectOne);
    expect(ids.length).toBe(ONBOARD_ENV_NAMES.length);
    expect([...ids].sort()).toEqual((await envIdsOf(projectOne)).sort());
  });

  it("two projects in the SAME team keep separate environments", async () => {
    const one = await seed(projectOne);
    const two = await seed(projectTwo);
    expect(new Set([...one, ...two]).size).toBe(6);
  });

  it("the idempotent re-run returns ONLY the asked project's 3 ids, never a sibling project's", async () => {
    const one = await seed(projectOne);
    await seed(projectTwo);

    const replay = await seed(projectOne);
    expect(replay.length).toBe(3);
    expect([...replay].sort()).toEqual([...one].sort());

    const replayTwo = await seed(projectTwo);
    expect(replayTwo.length).toBe(3);
    expect([...replayTwo].sort()).toEqual((await envIdsOf(projectTwo)).sort());
  });

  it("a replay adds no rows: the team still holds 3 environments per project", async () => {
    await seed(projectOne);
    await seed(projectOne);
    const r = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM pln_environments WHERE team_id = ${teamId}`,
    );
    expect(Number(r.rows[0]?.["n"])).toBe(3);
  });
});
