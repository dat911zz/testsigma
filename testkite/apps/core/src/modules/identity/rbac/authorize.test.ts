import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@testkite/contract";
import { assertGrantable, authorize, effectiveScopes } from "./authorize.js";

describe("scope hiệu lực = token.scopes ∩ rolePerms", () => {
  it("giao của hai tập, không phải hợp", () => {
    const eff = effectiveScopes("author", ["case:read", "case:write", "member:manage"]);
    expect(eff).toContain("case:read");
    expect(eff).toContain("case:write");
    // author KHÔNG có member:manage ⇒ token xin cũng vô hiệu.
    expect(eff).not.toContain("member:manage");
  });

  it("hạ vai của user là tước quyền của token NGAY, không cần thu hồi token", () => {
    const scopes = ["case:read", "case:write", "run:trigger"];
    expect(effectiveScopes("author", scopes)).toContain("case:write");
    expect(effectiveScopes("viewer", scopes)).toEqual(["case:read"]);
  });

  it("scope rác trong DB bị bỏ qua, không làm vỡ request", () => {
    expect(effectiveScopes("author", ["case:read", "khong-ton-tai", "case:*"])).toEqual(["case:read"]);
  });

  it("never-grantable không bao giờ vào scope hiệu lực của token thường", () => {
    expect(effectiveScopes("team_admin", ["secret:write", "case:read"], "user_pat")).toEqual(["case:read"]);
    expect(effectiveScopes("team_admin", ["secret:write", "case:read"], "service")).toEqual(["case:read"]);
  });

  it("session của người thật GIỮ được never-grantable nếu vai có", () => {
    expect(effectiveScopes("team_admin", ["secret:write"], "session")).toEqual(["secret:write"]);
    // nhưng vai không có thì vẫn không có
    expect(effectiveScopes("author", ["secret:write"], "session")).toEqual([]);
  });

  it("assertGrantable chặn phát token mang never-grantable", () => {
    expect(() => assertGrantable(["case:read"])).not.toThrow();
    expect(() => assertGrantable(["case:read", "secret:write"])).toThrow(ForbiddenError);
    expect(() => assertGrantable(["khong-ton-tai"])).toThrow(ForbiddenError);
  });

  it("authorize: có quyền ⇒ im lặng, thiếu quyền ⇒ ForbiddenError", () => {
    const ctx = { role: "author" as const, scopes: ["case:read"] as const };
    expect(() => authorize(ctx.role, ctx.scopes, "case:read")).not.toThrow();
    expect(() => authorize(ctx.role, ctx.scopes, "case:write")).toThrow(ForbiddenError);
  });

  it("authorize(null) = chỉ cần đăng nhập", () => {
    expect(() => authorize("viewer", [], null)).not.toThrow();
  });
});
