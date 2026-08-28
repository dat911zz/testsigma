import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineRoute, pathParamNames, toFastifyPath } from "./types.js";
import { ROUTES } from "./index.js";

describe("route descriptor", () => {
  it("toFastifyPath đổi {param} thành :param, roundtrip được", () => {
    expect(toFastifyPath("/v1/cases/{caseId}")).toBe("/v1/cases/:caseId");
    expect(toFastifyPath("/v1/teams/{teamId}/members/{userId}")).toBe("/v1/teams/:teamId/members/:userId");
    expect(toFastifyPath("/v1/cases")).toBe("/v1/cases");
  });

  it("pathParamNames liệt kê đúng tên param", () => {
    expect(pathParamNames("/v1/teams/{teamId}/members/{userId}")).toEqual(["teamId", "userId"]);
    expect(pathParamNames("/v1/cases")).toEqual([]);
  });

  it("defineRoute giữ nguyên kiểu literal của descriptor", () => {
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
  it("operationId là duy nhất toàn hệ", () => {
    const ids = ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cặp (method, path) là duy nhất", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("mọi route bắt đầu bằng /v1/ và KHÔNG nhận teamId từ client", () => {
    for (const r of ROUTES) {
      expect(r.path.startsWith("/v1/")).toBe(true);
      // teamId đến từ credential, không bao giờ từ path/query/body (Global Constraints).
      expect(pathParamNames(r.path)).not.toContain("teamId");
      expect(Object.keys(r.query?.shape ?? {})).not.toContain("teamId");
    }
  });

  it("mọi route có path param BẮT BUỘC khai response 404 — luật L3 404-không-403", () => {
    for (const r of ROUTES) {
      if (pathParamNames(r.path).length === 0) continue;
      expect(Object.keys(r.responses)).toContain("404");
    }
  });

  it("mọi path param đều là uuid — id đoán được là lỗ liệt kê tài nguyên", () => {
    for (const r of ROUTES) {
      for (const name of pathParamNames(r.path)) {
        const shape = r.params?.shape[name];
        expect(shape, `${r.operationId}: thiếu schema cho ${name}`).toBeDefined();
        expect(JSON.stringify(shape?._def)).toContain("uuid");
      }
    }
  });

  it("route auth=required phải khai permission hoặc null tường minh", () => {
    for (const r of ROUTES) {
      if (r.auth === "public") expect(r.permission).toBeNull();
    }
  });
});
