import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute, pathParamNames, toFastifyPath } from "./types.js";
import { ROUTES } from "./index.js";

describe("route descriptor", () => {
  it("toFastifyPath turns {param} into :param, roundtrips", () => {
    expect(toFastifyPath("/v1/cases/{caseId}")).toBe("/v1/cases/:caseId");
    expect(toFastifyPath("/v1/teams/{teamId}/members/{userId}")).toBe("/v1/teams/:teamId/members/:userId");
    expect(toFastifyPath("/v1/cases")).toBe("/v1/cases");
  });

  it("pathParamNames lists the right param names", () => {
    expect(pathParamNames("/v1/teams/{teamId}/members/{userId}")).toEqual(["teamId", "userId"]);
    expect(pathParamNames("/v1/cases")).toEqual([]);
  });

  it("defineRoute keeps the descriptor's literal type", () => {
    const r = defineRoute({
      operationId: "probe",
      method: "get",
      path: "/v1/probe/{id}",
      summary: "probe",
      auth: "required",
      permission: "case:read",
      params: z.object({ id: z.string().uuid() }),
      responses: { 200: z.object({ ok: z.literal(true) }) },
    });
    expect(r.operationId).toBe("probe");
    expect(r.params?.shape["id"]).toBeDefined();
  });
});

describe("ROUTES", () => {
  it("operationId is unique system-wide", () => {
    const ids = ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the (method, path) pair is unique", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every route starts with /v1/ and does NOT accept teamId from the client", () => {
    for (const r of ROUTES) {
      expect(r.path.startsWith("/v1/")).toBe(true);
      // teamId comes from the credential, never from path/query/body (Global Constraints).
      expect(pathParamNames(r.path)).not.toContain("teamId");
      expect(Object.keys(r.query?.shape ?? {})).not.toContain("teamId");
    }
  });

  it("every route with a path param MUST declare a 404 response — the L3 404-not-403 rule", () => {
    for (const r of ROUTES) {
      if (pathParamNames(r.path).length === 0) continue;
      expect(Object.keys(r.responses)).toContain("404");
    }
  });

  it("every path param is a uuid — a guessable id is a resource-enumeration hole", () => {
    for (const r of ROUTES) {
      for (const name of pathParamNames(r.path)) {
        const shape = r.params?.shape[name];
        expect(shape, `${r.operationId}: missing schema for ${name}`).toBeDefined();
        expect(JSON.stringify(shape?._def)).toContain("uuid");
      }
    }
  });

  it("an auth=required route must explicitly declare a permission or null", () => {
    for (const r of ROUTES) {
      if (r.auth === "public") expect(r.permission).toBeNull();
    }
  });
});
