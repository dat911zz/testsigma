/**
 * Team onboarding = ONE transaction (blueprint §3). This test suite checks exactly three
 * promises: completeness (team + project + admin + service token + 3 envs + quota + egress
 * observe), idempotency (calling again with the same key duplicates nothing and doesn't
 * reissue the secret), and atomicity (a mid-flight failure leaves no orphaned team behind).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { onboardTeam, teamIdFor } from "../../src/http/usecases/onboard-team.js";

let h: TestApp;
beforeAll(async () => {
  h = await makeTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.seed();
});

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  orgId: h.ids.orgId,
  name: "Team Mới",
  slug: "team-moi",
  adminEmail: "boss@acme.test",
  baseUrl: "https://app.acme.test",
  idempotencyKey: "onboard-key-0001",
  ...over,
});

/**
 * Creating a new team requires `team:create` — a permission ONLY org_admin/instance_operator
 * hold. An ordinary team_admin cannot open this door (see the escalation test below).
 */
const onboard = (over: Record<string, unknown> = {}): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${h.tokens.orgAdminA}` },
    payload: payload(over),
  });

/** Collects the message of the whole `cause` chain — the real DB error sits below the drizzle wrapper layer. */
const flattenError = (e: unknown): string => {
  let out = "";
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur instanceof Error; i += 1) {
    out += `${cur.message}\n`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
};

type OnboardBody = {
  teamId: string;
  projectId: string;
  environmentIds: string[];
  serviceTokenPrefix: string;
  created: boolean;
};

describe("onboarding team", () => {
  it("one call creates EVERYTHING: team + project + admin + service token + 3 envs + quota + egress observe", async () => {
    const r = await onboard();
    expect(r.statusCode).toBe(201);
    const body = r.json() as OnboardBody;
    expect(body.created).toBe(true);
    expect(body.environmentIds.length).toBe(3);

    const q = async (sqlText: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
      (await h.db.raw.query<Record<string, unknown>>(sqlText, params)).rows;
    expect((await q(`SELECT id FROM teams WHERE slug='team-moi'`)).length).toBe(1);
    expect((await q(`SELECT id FROM projects WHERE team_id=$1`, [body.teamId])).length).toBe(1);
    expect((await q(`SELECT role FROM memberships WHERE team_id=$1`, [body.teamId]))[0]).toMatchObject({
      role: "team_admin",
    });
    expect(
      (
        await q(`SELECT name, status FROM pln_environments WHERE team_id=$1 ORDER BY name`, [body.teamId])
      ).map((x) => x["name"]),
    ).toEqual(["dev", "prod", "staging"]);
    expect((await q(`SELECT * FROM quota_limits WHERE team_id=$1`, [body.teamId])).length).toBe(1);
    const egress = (
      await q(`SELECT mode, allowlist, observe_until FROM egress_policies WHERE team_id=$1`, [body.teamId])
    )[0];
    expect(egress).toMatchObject({ mode: "observe" });
    expect(String(egress?.["allowlist"])).toContain("app.acme.test");
    const tokens = await q(`SELECT kind, prefix FROM api_tokens WHERE team_id=$1`, [body.teamId]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: "service", prefix: body.serviceTokenPrefix });
  });

  it("calling AGAIN with the same idempotencyKey ⇒ 201, created=false, duplicates NOTHING", async () => {
    const first = (await onboard()).json() as OnboardBody;
    const second = await onboard();
    const body = second.json() as OnboardBody;
    expect(second.statusCode).toBe(201);
    expect(body.created).toBe(false);
    expect(body.teamId).toBe(first.teamId);
    const rows = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pln_environments WHERE team_id=$1`,
      [first.teamId],
    );
    expect(rows.rows[0]?.n).toBe(3);
    const tk = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_tokens WHERE team_id=$1`,
      [first.teamId],
    );
    expect(tk.rows[0]?.n).toBe(1);
    const eg = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM egress_policies WHERE team_id=$1`,
      [first.teamId],
    );
    expect(eg.rows[0]?.n).toBe(1);
  });

  it("a replay does NOT return the service token's secret again (secret is one-time only)", async () => {
    await onboard();
    const second = await onboard();
    expect(JSON.stringify(second.json())).not.toContain("tk_");
  });

  it("a duplicate slug in the same org (different idempotencyKey) ⇒ 409, no half-created team", async () => {
    await onboard();
    const r = await onboard({ idempotencyKey: "onboard-key-0002" });
    expect(r.statusCode).toBe(409);
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-moi'`,
    );
    expect(teams.rows[0]?.n).toBe(1);
  });

  it("a broken baseUrl ⇒ 400 from the CONTRACT LAYER (including an unknown scheme), not 500", async () => {
    // `z.string().url()` alone accepts ftp:/mailto:/file: — while the pln_environments
    // CHECK constraint only allows http(s). That mismatch would turn a client input error
    // into a 500 INTERNAL. The contract must catch BOTH kinds of failure as a 400.
    // `idempotencyKey` must be at least 8 characters, otherwise IT becomes the thing that
    // 400s and the test says nothing about baseUrl (a trap from an earlier version).
    for (const bad of ["khong-phai-url", "ftp://bad.example.test"]) {
      const r = await onboard({ slug: "team-hong", baseUrl: bad, idempotencyKey: "k-hong-0001" });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    const rows = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-hong'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("a mid-flight failure ⇒ FULL rollback (team + user + membership + token + quota)", async () => {
    // Call the use case DIRECTLY: only this path can open a transaction and then die
    // partway through. Going through HTTP means the contract rejects it before the DB is
    // even touched — that kind of "rollback" would prove nothing.
    const key = "k-rollback-that-su";
    const teamId = teamIdFor(h.ids.orgId, key);
    const err = await onboardTeam(
      { db: h.db.db },
      {
        orgId: h.ids.orgId,
        name: "Team Hỏng",
        slug: "team-hong-that",
        adminEmail: "hong@acme.test",
        baseUrl: "ftp://bad.example.test",
        idempotencyKey: key,
        actorUserId: h.ids.orgAdminUser,
      },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    // Dies exactly at pln_environments' CHECK constraint ⇒ the team/user/token were
    // already written EARLIER in the same transaction, so the zero counts below prove a real rollback.
    expect(flattenError(err)).toContain("pln_environments_base_url_check");

    const count = async (sqlText: string, params: unknown[]): Promise<number | undefined> =>
      (await h.db.raw.query<{ n: number }>(sqlText, params)).rows[0]?.n;
    expect(await count(`SELECT count(*)::int AS n FROM teams WHERE id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM memberships WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM api_tokens WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM quota_limits WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM projects WHERE team_id=$1`, [teamId])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE email=$1`, ["hong@acme.test"])).toBe(0);
  });

  it("everything created belongs to the EXACT new team, none of it leaks to the caller's team", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const stray = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pln_environments WHERE team_id = $1`,
      [h.ids.teamA],
    );
    expect(stray.rows[0]?.n).toBe(0);
    expect(body.teamId).not.toBe(h.ids.teamA);
  });

  it("writes exactly ONE HIGH team.onboard audit entry for the new team", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const r = await h.db.raw.query<{ action: string; severity: string; team_id: string }>(
      `SELECT action, severity, team_id FROM audit_events WHERE action='team.onboard'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ severity: "HIGH", team_id: body.teamId });
  });

  it("missing the team:create permission ⇒ 403", async () => {
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { authorization: `Bearer ${h.tokens.authorA}` },
      payload: payload({ slug: "team-khac", idempotencyKey: "k-author-0001" }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("an ORDINARY team_admin cannot create a new team — team:manage does NOT open this door", async () => {
    // A previously reproduced escalation: `team:manage` is held by EVERY team_admin, so
    // anyone could spin up a team and self-assign as its admin. Creating a team is an ORG-level permission.
    const r = await h.app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: { authorization: `Bearer ${h.tokens.adminA}` },
      payload: payload({ slug: "team-leo-thang", idempotencyKey: "k-leo-thang" }),
    });
    expect(r.statusCode).toBe(403);
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-leo-thang'`,
    );
    expect(teams.rows[0]?.n).toBe(0);
  });

  it("does NOT force an existing account into a new team: another person's adminEmail ⇒ 409", async () => {
    // With no invite-accept step in M2 ⇒ the only safe path is to REFUSE, rather than
    // silently attaching a team_admin membership for someone who has no idea it happened.
    const r = await onboard({
      adminEmail: "author@acme.test",
      slug: "team-ep-buoc",
      idempotencyKey: "k-ep-buoc",
    });
    expect(r.statusCode).toBe(409);
    const mem = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memberships WHERE user_id=$1`,
      [h.ids.authorUser],
    );
    expect(mem.rows[0]?.n).toBe(1); // still exactly the one existing membership on team A
    const teams = await h.db.raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM teams WHERE slug='team-ep-buoc'`,
    );
    expect(teams.rows[0]?.n).toBe(0);
  });

  it("egress observe expires exactly 14 days from onboarding", async () => {
    const body = (await onboard()).json() as OnboardBody;
    const r = await h.db.raw.query<{ days: number }>(
      `SELECT round(EXTRACT(epoch FROM (observe_until - now())) / 86400)::int AS days
       FROM egress_policies WHERE team_id=$1`,
      [body.teamId],
    );
    expect(r.rows[0]?.days).toBe(14);
  });
});
