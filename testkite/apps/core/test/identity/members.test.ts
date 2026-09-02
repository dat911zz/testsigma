/**
 * Privilege-escalation guards on PATCH /v1/members/{userId}.
 *
 * `member:manage` is ONE permission, and before this suite it meant "write any role onto
 * anybody in this team". Two escalation paths follow from that, and both are reachable with
 * nothing but a plain team_admin credential:
 *   1. write a role STRONGER than the caller's own (team_admin -> instance_operator, which
 *      carries `team:purge` and `token:issue:service`),
 *   2. write a role onto YOURSELF — the same move, taken in one step instead of two, and the
 *      one that also makes an operator's own demotion reversible by the operator.
 * The matrix that closes (1) is `GRANTABLE_ROLES` in rbac/permissions.ts, so the boundary is
 * code under review like the rest of RBAC, not a table an admin can edit.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { makeTestApp, type TestApp } from "../harness/http.js";

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

const patch = (
  secret: string,
  userId: string,
  role: string,
): ReturnType<TestApp["app"]["inject"]> =>
  h.app.inject({
    method: "PATCH",
    url: `/v1/members/${userId}`,
    headers: { authorization: `Bearer ${secret}` },
    payload: { role },
  });

const roleOf = async (userId: string): Promise<string | undefined> => {
  const r = await h.db.raw.query<{ role: string }>(
    `SELECT role FROM memberships WHERE team_id = $1 AND user_id = $2`,
    [h.ids.teamA, userId],
  );
  return r.rows[0]?.role;
};

describe("PATCH /v1/members/{userId} — role escalation guards", () => {
  it("team_admin cannot grant instance_operator (403)", async () => {
    const r = await patch(h.tokens.adminA, h.ids.authorUser, "instance_operator");
    expect(r.statusCode).toBe(403);
    // Refused BEFORE the UPDATE, not refused after writing it.
    expect(await roleOf(h.ids.authorUser)).toBe("author");
  });

  it("member:manage cannot change its own role (403)", async () => {
    const r = await patch(h.tokens.adminA, h.ids.adminUser, "instance_operator");
    expect(r.statusCode).toBe(403);
    expect(await roleOf(h.ids.adminUser)).toBe("team_admin");
  });

  it("a self-role-change is refused even when it is a DEMOTION", async () => {
    // The guard is "not yourself", not "not an escalation": an operator who can demote
    // themselves can also promote themselves back, and the audit trail would show one
    // person moving their own role in both directions.
    const r = await patch(h.tokens.adminA, h.ids.adminUser, "viewer");
    expect(r.statusCode).toBe(403);
    expect(await roleOf(h.ids.adminUser)).toBe("team_admin");
  });

  it("team_admin cannot grant org_admin either — the ceiling is the caller's own role", async () => {
    const r = await patch(h.tokens.adminA, h.ids.authorUser, "org_admin");
    expect(r.statusCode).toBe(403);
    expect(await roleOf(h.ids.authorUser)).toBe("author");
  });

  it("team_admin CAN still grant the roles below it", async () => {
    for (const role of ["viewer", "runner", "author"]) {
      const r = await patch(h.tokens.adminA, h.ids.authorUser, role);
      expect(r.statusCode, `team_admin -> ${role}`).toBe(200);
      expect(await roleOf(h.ids.authorUser)).toBe(role);
    }
  });

  it("org_admin CAN grant team_admin — one step above what a team_admin may grant", async () => {
    const r = await patch(h.tokens.orgAdminA, h.ids.authorUser, "team_admin");
    expect(r.statusCode).toBe(200);
    expect(await roleOf(h.ids.authorUser)).toBe("team_admin");
  });

  it("org_admin still cannot grant instance_operator", async () => {
    const r = await patch(h.tokens.orgAdminA, h.ids.authorUser, "instance_operator");
    expect(r.statusCode).toBe(403);
    expect(await roleOf(h.ids.authorUser)).toBe("author");
  });

  it("team_admin cannot demote an org_admin (403)", async () => {
    // Clamping only the role being WRITTEN left the role being OVERWRITTEN wide open, and
    // the two are not the same guard. `GRANTABLE_ROLES` says a team_admin is not trusted
    // enough to CREATE an org_admin; before this fix it could still DESTROY one — remove
    // the single account standing above it in this team, which is also the only party that
    // can hand the role back (org_admin is the lowest role that may grant team_admin), and
    // leave behind an ordinary-looking `member.role_change` audit line. Measured on this
    // exact request before the fix: 200, and the membership row read back `viewer`.
    const r = await patch(h.tokens.adminA, h.ids.orgAdminUser, "viewer");
    expect(r.statusCode).toBe(403);
    expect(await roleOf(h.ids.orgAdminUser)).toBe("org_admin");
  });

  it("org_admin CAN demote a team_admin — the new guard is a ceiling, not a freeze", async () => {
    // The companion to the test above: refusing every overwrite would have been the easy
    // way to make it pass, and would have broken the one demotion the matrix does allow.
    const r = await patch(h.tokens.orgAdminA, h.ids.adminUser, "viewer");
    expect(r.statusCode).toBe(200);
    expect(await roleOf(h.ids.adminUser)).toBe("viewer");
  });

  it("an unknown member is still 404, and the escalation guard runs FIRST", async () => {
    // Order matters: answering 404 for a role the caller may not grant would turn this
    // route into a membership oracle for anyone holding `member:manage`.
    const absent = "00000000-0000-4000-8000-0000000000ff";
    expect((await patch(h.tokens.adminA, absent, "viewer")).statusCode).toBe(404);
    expect((await patch(h.tokens.adminA, absent, "instance_operator")).statusCode).toBe(403);
  });
});
