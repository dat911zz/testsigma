import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "@testkite/contract";
import { buildHttpApp, type TkApp } from "../../src/http/app.js";

const ENV = {
  NODE_ENV: "test" as const,
  PORT: 8080,
  DATABASE_URL: "postgres://tk:pw@localhost:5432/testkite",
  DATABASE_APP_ROLE: "testkite_app",
  DATABASE_POOL_MAX: 10,
  LOG_LEVEL: "silent" as const,
};

let app: TkApp;

beforeAll(async () => {
  app = await buildHttpApp({
    env: { ...ENV, LOG_LEVEL: "error" },
    db: undefined as never,
    // Skeleton test: no route here declares a descriptor ⇒ the auth hook never touches
    // the authenticator. The surface with real auth lives in test/http/auth.test.ts.
    authenticator: { authenticate: async () => null },
    registrations: [],
  });
  // A probe route that ONLY exists in this test — the real surface arrives in Task 2/Task 6.
  app.withTypeProvider().route({
    method: "POST",
    url: "/__probe/:id",
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ name: z.string().min(3) }),
      response: { 200: z.object({ name: z.string() }) },
    },
    handler: async (req) => ({ name: req.body.name, khongDuocLo: "secret" }),
  });
  app.get("/__boom", async () => {
    throw new Error("internal details must not leak");
  });
  app.get("/__forbidden", async () => {
    throw new ForbiddenError("missing case:write");
  });
  app.get("/__missing", async () => {
    throw new NotFoundError("case");
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const UUID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

describe("skeleton HTTP", () => {
  it("GET /healthz returns 200 without needing a credential", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok" });
  });

  it("validates the body via zod ⇒ 400 VALIDATION_FAILED with an issue", async () => {
    const r = await app.inject({ method: "POST", url: `/__probe/${UUID}`, payload: { name: "ab" } });
    expect(r.statusCode).toBe(400);
    const body = r.json() as { code: string; issues: string[]; requestId: string };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.issues.join(" ")).toMatch(/at least 3/i);
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("validates the uuid path param ⇒ 400, not 500", async () => {
    const r = await app.inject({ method: "POST", url: "/__probe/khong-phai-uuid", payload: { name: "abc" } });
    expect(r.statusCode).toBe(400);
  });

  it("the serializer STRIPS fields not declared in the response schema", async () => {
    const r = await app.inject({ method: "POST", url: `/__probe/${UUID}`, payload: { name: "abcd" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ name: "abcd" });
  });

  it("AppError → the right status + code", async () => {
    expect((await app.inject({ method: "GET", url: "/__forbidden" })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", url: "/__missing" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("an unknown error → 500 INTERNAL, does NOT leak the internal message", async () => {
    const r = await app.inject({ method: "GET", url: "/__boom" });
    expect(r.statusCode).toBe(500);
    const body = r.json() as { code: string; message: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.message).not.toContain("internal details");
  });

  it("a nonexistent route → 404 with the shared payload shape", async () => {
    const r = await app.inject({ method: "GET", url: "/khong-ton-tai" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});
