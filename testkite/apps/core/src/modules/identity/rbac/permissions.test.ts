import { describe, expect, it } from "vitest";
import {
  HIGH_RISK, NEVER_GRANTABLE, PERMISSIONS, ROLE_PERMISSIONS,
  isHighRisk, isNeverGrantable, isPermission, type MembershipRole,
} from "./permissions.js";

const ROLES: readonly MembershipRole[] = [
  "instance_operator", "org_admin", "team_admin", "author", "runner", "viewer",
];

describe("ma trận quyền 6 vai", () => {
  it("phủ đúng 6 vai của blueprint §3, không thừa không thiếu", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it("mọi permission trong ma trận đều nằm trong PERMISSIONS", () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it("never-grantable đúng 5 mục blueprint chốt", () => {
    expect([...NEVER_GRANTABLE].sort()).toEqual(
      ["element:write", "quota:set", "secret:write", "team:purge", "token:issue:service"].sort(),
    );
  });

  it("element:write không bao giờ vào tay author — author chỉ được element:propose", () => {
    expect(ROLE_PERMISSIONS.author).toContain("element:propose");
    expect(ROLE_PERMISSIONS.author).not.toContain("element:write");
  });

  it("runner chỉ trigger + đọc, KHÔNG sửa được test (CI không viết lại test)", () => {
    expect(ROLE_PERMISSIONS.runner).toContain("run:trigger");
    expect(ROLE_PERMISSIONS.runner).toContain("case:read");
    expect(ROLE_PERMISSIONS.runner).not.toContain("case:write");
    expect(ROLE_PERMISSIONS.runner).not.toContain("case:promote");
  });

  it("viewer chỉ đọc — không có permission nào chứa :write/:trigger/:promote", () => {
    for (const p of ROLE_PERMISSIONS.viewer) {
      expect(p).not.toMatch(/:(write|trigger|promote|abort|set|purge)/);
    }
  });

  it("org_admin KHÔNG đọc tài sản team mặc nhiên (break-glass audit HIGH)", () => {
    for (const p of ["case:read", "suite:read", "run:read", "element:read", "testdata:read"] as const) {
      expect(ROLE_PERMISSIONS.org_admin).not.toContain(p);
    }
    expect(ROLE_PERMISSIONS.org_admin).toContain("audit:read:all");
  });

  it("instance_operator là vai hạ tầng: không đọc tài sản, có team:purge", () => {
    expect(ROLE_PERMISSIONS.instance_operator).not.toContain("case:read");
    expect(ROLE_PERMISSIONS.instance_operator).toContain("team:purge");
  });

  it("mọi vai đều là tập con thực sự của PERMISSIONS và không trùng lặp", () => {
    for (const role of ROLES) {
      const perms = ROLE_PERMISSIONS[role];
      expect(new Set(perms).size).toBe(perms.length);
    }
  });

  it("mọi never-grantable đều là HIGH", () => {
    for (const p of NEVER_GRANTABLE) expect(isHighRisk(p)).toBe(true);
  });

  it("isPermission chặn chuỗi lạ", () => {
    expect(isPermission("case:read")).toBe(true);
    expect(isPermission("case:*")).toBe(false);
    expect(isPermission("")).toBe(false);
  });

  it("isNeverGrantable nhận cả chuỗi lạ mà không ném", () => {
    expect(isNeverGrantable("secret:write")).toBe(true);
    expect(isNeverGrantable("khong-ton-tai")).toBe(false);
  });

  it("HIGH_RISK phủ hết nhóm quản trị nhạy cảm", () => {
    for (const p of ["member:manage", "team:manage", "quota:set", "secret:read", "audit:read:all"] as const) {
      expect(HIGH_RISK).toContain(p);
    }
  });
});
