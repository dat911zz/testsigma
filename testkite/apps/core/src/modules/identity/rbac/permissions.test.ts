import { describe, expect, it } from "vitest";
import {
  HIGH_RISK, NEVER_GRANTABLE, PERMISSIONS, ROLE_PERMISSIONS,
  isHighRisk, isNeverGrantable, isPermission, type MembershipRole,
} from "./permissions.js";

const ROLES: readonly MembershipRole[] = [
  "instance_operator", "org_admin", "team_admin", "author", "runner", "viewer",
];

describe("6-role permission matrix", () => {
  it("covers exactly the 6 roles from blueprint §3, no more no less", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it("every permission in the matrix is in PERMISSIONS", () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it("never-grantable is exactly the 5 entries the blueprint locked in", () => {
    expect([...NEVER_GRANTABLE].sort()).toEqual(
      ["element:write", "quota:set", "secret:write", "team:purge", "token:issue:service"].sort(),
    );
  });

  it("element:write never reaches author — author only gets element:propose", () => {
    expect(ROLE_PERMISSIONS.author).toContain("element:propose");
    expect(ROLE_PERMISSIONS.author).not.toContain("element:write");
  });

  it("runner is trigger + read only, CANNOT edit tests (CI doesn't rewrite tests)", () => {
    expect(ROLE_PERMISSIONS.runner).toContain("run:trigger");
    expect(ROLE_PERMISSIONS.runner).toContain("case:read");
    expect(ROLE_PERMISSIONS.runner).not.toContain("case:write");
    expect(ROLE_PERMISSIONS.runner).not.toContain("case:promote");
  });

  it("viewer is read-only — no permission contains :write/:trigger/:promote", () => {
    for (const p of ROLE_PERMISSIONS.viewer) {
      expect(p).not.toMatch(/:(write|trigger|promote|abort|set|purge)/);
    }
  });

  it("org_admin does NOT read team assets by default (break-glass audit HIGH)", () => {
    for (const p of ["case:read", "suite:read", "run:read", "element:read", "testdata:read"] as const) {
      expect(ROLE_PERMISSIONS.org_admin).not.toContain(p);
    }
    expect(ROLE_PERMISSIONS.org_admin).toContain("audit:read:all");
  });

  it("creating a new team is an ORG-LEVEL permission: team_admin doesn't have team:create", () => {
    // Folding team creation into `team:manage` would be a privilege-escalation path —
    // every team_admin has `team:manage`, and team_admin is the most common role in the system.
    expect(ROLE_PERMISSIONS.team_admin).toContain("team:manage");
    expect(ROLE_PERMISSIONS.team_admin).not.toContain("team:create");
    expect(ROLE_PERMISSIONS.org_admin).toContain("team:create");
    expect(ROLE_PERMISSIONS.instance_operator).toContain("team:create");
    for (const role of ["author", "runner", "viewer"] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("team:create");
    }
    expect(isHighRisk("team:create")).toBe(true);
  });

  it("instance_operator is an infra role: no asset reads, but has team:purge", () => {
    expect(ROLE_PERMISSIONS.instance_operator).not.toContain("case:read");
    expect(ROLE_PERMISSIONS.instance_operator).toContain("team:purge");
  });

  it("every role is a proper subset of PERMISSIONS with no duplicates", () => {
    for (const role of ROLES) {
      const perms = ROLE_PERMISSIONS[role];
      expect(new Set(perms).size).toBe(perms.length);
    }
  });

  it("every never-grantable permission is HIGH", () => {
    for (const p of NEVER_GRANTABLE) expect(isHighRisk(p)).toBe(true);
  });

  it("isPermission rejects an unknown string", () => {
    expect(isPermission("case:read")).toBe(true);
    expect(isPermission("case:*")).toBe(false);
    expect(isPermission("")).toBe(false);
  });

  it("isNeverGrantable accepts even an unknown string without throwing", () => {
    expect(isNeverGrantable("secret:write")).toBe(true);
    expect(isNeverGrantable("does-not-exist")).toBe(false);
  });

  it("HIGH_RISK covers the whole sensitive admin group", () => {
    for (const p of ["member:manage", "team:manage", "quota:set", "secret:read", "audit:read:all"] as const) {
      expect(HIGH_RISK).toContain(p);
    }
  });
});
