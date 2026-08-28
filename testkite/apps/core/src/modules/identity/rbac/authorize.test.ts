import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@testkite/contract";
import { assertGrantable, authorize, effectiveScopes } from "./authorize.js";

describe("effective scope = token.scopes ∩ rolePerms", () => {
  it("is an intersection of the two sets, not a union", () => {
    const eff = effectiveScopes("author", ["case:read", "case:write", "member:manage"]);
    expect(eff).toContain("case:read");
    expect(eff).toContain("case:write");
    // author does NOT have member:manage ⇒ the token asking for it has no effect.
    expect(eff).not.toContain("member:manage");
  });

  it("demoting a user's role strips a token's permissions IMMEDIATELY, no revoke needed", () => {
    const scopes = ["case:read", "case:write", "run:trigger"];
    expect(effectiveScopes("author", scopes)).toContain("case:write");
    expect(effectiveScopes("viewer", scopes)).toEqual(["case:read"]);
  });

  it("a stale scope in the DB is skipped, doesn't break the request", () => {
    expect(effectiveScopes("author", ["case:read", "does-not-exist", "case:*"])).toEqual(["case:read"]);
  });

  it("never-grantable never enters a regular token's effective scope", () => {
    expect(effectiveScopes("team_admin", ["secret:write", "case:read"], "user_pat")).toEqual(["case:read"]);
    expect(effectiveScopes("team_admin", ["secret:write", "case:read"], "service")).toEqual(["case:read"]);
  });

  it("a real human's session KEEPS never-grantable if the role has it", () => {
    expect(effectiveScopes("team_admin", ["secret:write"], "session")).toEqual(["secret:write"]);
    // but still absent when the role doesn't have it
    expect(effectiveScopes("author", ["secret:write"], "session")).toEqual([]);
  });

  it("assertGrantable blocks issuing a token carrying never-grantable", () => {
    expect(() => assertGrantable(["case:read"])).not.toThrow();
    expect(() => assertGrantable(["case:read", "secret:write"])).toThrow(ForbiddenError);
    expect(() => assertGrantable(["does-not-exist"])).toThrow(ForbiddenError);
  });

  it("authorize: has the permission ⇒ silent, missing it ⇒ ForbiddenError", () => {
    const ctx = { role: "author" as const, scopes: ["case:read"] as const };
    expect(() => authorize(ctx.role, ctx.scopes, "case:read")).not.toThrow();
    expect(() => authorize(ctx.role, ctx.scopes, "case:write")).toThrow(ForbiddenError);
  });

  it("authorize(null) = just needs to be logged in", () => {
    expect(() => authorize("viewer", [], null)).not.toThrow();
  });
});
