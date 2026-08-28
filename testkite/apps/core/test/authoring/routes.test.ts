/**
 * The case lifecycle over HTTP — the M2 exit criteria. This drives the real routes,
 * real services and a real (PGlite) database; only the identity layer is faked, by an
 * onRequest hook that sets `request.tk` the way the identity middleware does. Auth
 * itself is covered elsewhere (identity's suites + the L3 cross-tenant suite that runs
 * these routes through the real auth hook).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { authoringRoutes } from "../../src/modules/authoring/index.js";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

let t: TestDb;
let app: FastifyInstance;
let teamId = "";
let projectId = "";
const alice = { userId: "" };
const bob = { userId: "" };
/** Stand-in for what the identity middleware decorates onto each request. */
let current = { teamId: "", userId: "", scopes: [] as string[] };

beforeAll(async () => {
  t = await makeTestDb();
  app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { tk: typeof current }).tk = current;
  });
  await app.register(authoringRoutes(t.db));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const org = await t.db.execute(sql`INSERT INTO organizations (name, slug) VALUES ('Acme','acme') RETURNING id`);
  const orgId = String(org.rows[0]?.["id"]);
  const team = await t.db.execute(sql`INSERT INTO teams (org_id,name,slug) VALUES (${orgId},'A','a') RETURNING id`);
  teamId = String(team.rows[0]?.["id"]);
  const p = await t.db.execute(sql`INSERT INTO projects (team_id,name,slug) VALUES (${teamId},'P','p') RETURNING id`);
  projectId = String(p.rows[0]?.["id"]);
  const u1 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('a@x.test','Alice') RETURNING id`);
  const u2 = await t.db.execute(sql`INSERT INTO users (email, display_name) VALUES ('b@x.test','Bob') RETURNING id`);
  alice.userId = String(u1.rows[0]?.["id"]);
  bob.userId = String(u2.rows[0]?.["id"]);
  current = { teamId, userId: alice.userId, scopes: ["case:read", "case:write", "case:promote"] };
});

describe("full lifecycle over HTTP (M2 exit criteria)", () => {
  it("create -> edit steps -> submit -> review -> promote, over HTTP only", async () => {
    // 1. create
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "Checkout", isStepGroup: false },
    });
    expect(created.statusCode).toBe(201);
    const caseId = created.json<{ id: string }>().id;
    expect(created.headers["etag"]).toBe('"1"');

    // 2. edit steps (If-Match taken straight from the previous ETag)
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/cases/${caseId}/steps`,
      headers: { "if-match": String(created.headers["etag"]) },
      payload: { steps: [{ kind: "action", renderedSentence: "open login page", verbOpKey: "goto" }] },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.headers["etag"]).toBe('"2"');

    // 3. submit
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/submit-review`,
      headers: { "if-match": String(edited.headers["etag"]) },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ status: string }>().status).toBe("in_review");

    // 4. Bob reviews
    current = { ...current, userId: bob.userId };
    const reviewed = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/review`,
      headers: { "if-match": String(submitted.headers["etag"]) },
      payload: { decision: "approved" },
    });
    expect(reviewed.statusCode).toBe(200);

    // 5. Bob promotes (Alice was the last editor, so only Bob may promote)
    const promoted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/promote`,
      headers: { "if-match": String(reviewed.headers["etag"]) },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<{ status: string }>().status).toBe("ready");
    expect(promoted.json<{ readyRevisionId?: string }>().readyRevisionId).toBeDefined();
  });
});

describe("optimistic concurrency over HTTP", () => {
  async function newCase(): Promise<{ id: string; etag: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    return { id: res.json<{ id: string }>().id, etag: String(res.headers["etag"]) };
  }

  it("PUT without If-Match -> 428 if_match_required", async () => {
    const c = await newCase();
    const res = await app.inject({ method: "PUT", url: `/v1/cases/${c.id}/steps`, payload: { steps: [] } });
    expect(res.statusCode).toBe(428);
    expect(res.json<{ code: string }>().code).toBe("if_match_required");
  });

  it("If-Match: * -> 428 (concurrency check cannot be disabled)", async () => {
    const c = await newCase();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": "*" },
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(428);
  });

  it("stale If-Match -> 409 with a 3-way diff carrying all three anchors", async () => {
    const c = await newCase();
    await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": c.etag },
      payload: { steps: [{ kind: "action", renderedSentence: "s1", verbOpKey: "click" }] },
    });
    const stale = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.id}/steps`,
      headers: { "if-match": c.etag },
      payload: { steps: [{ kind: "action", renderedSentence: "s2", verbOpKey: "click" }] },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json<{
      code: string;
      diff: { baseVersion: number; currentVersion: number; mine: unknown[]; theirs: unknown[]; conflicts: string[] };
    }>();
    expect(body.code).toBe("version_conflict");
    expect(body.diff.baseVersion).toBe(1);
    expect(body.diff.currentVersion).toBe(2);
    expect(body.diff.mine.length).toBeGreaterThan(0);
    expect(body.diff.theirs.length).toBeGreaterThan(0);
  });
});

describe("tenant isolation + scope", () => {
  it("a case in another team -> 404, NEVER 403 (blueprint §3 L3)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const caseId = created.json<{ id: string }>().id;

    const org = await t.db.execute(sql`SELECT id FROM organizations LIMIT 1`);
    const other = await t.db.execute(
      sql`INSERT INTO teams (org_id,name,slug) VALUES (${String(org.rows[0]?.["id"])},'B','b') RETURNING id`,
    );
    current = { ...current, teamId: String(other.rows[0]?.["id"]) };

    const res = await app.inject({ method: "GET", url: `/v1/cases/${caseId}` });
    expect(res.statusCode).toBe(404);
    expect(res.statusCode).not.toBe(403);
    expect(res.json<{ code: string }>().code).toBe("NOT_FOUND");
  });

  it("missing scope -> 403 (same-tenant permission failure)", async () => {
    current = { ...current, scopes: ["case:read"] };
    const res = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe("FORBIDDEN");
  });

  it("four-eyes over HTTP: the last editor self-promoting -> 403 four_eyes_self_promote", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const caseId = created.json<{ id: string }>().id;
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/submit-review`,
      headers: { "if-match": String(created.headers["etag"]) },
    });
    current = { ...current, userId: bob.userId };
    const reviewed = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/review`,
      headers: { "if-match": String(submitted.headers["etag"]) },
      payload: { decision: "approved" },
    });
    // Alice is the last editor (she created the case) — her promoting is the violation.
    current = { ...current, userId: alice.userId };
    const res = await app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/promote`,
      headers: { "if-match": String(reviewed.headers["etag"]) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe("four_eyes_self_promote");
  });

  it("malformed body -> 400, not 500", async () => {
    const c = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/cases`,
      payload: { name: "C", isStepGroup: false },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/v1/cases/${c.json<{ id: string }>().id}/steps`,
      headers: { "if-match": String(c.headers["etag"]) },
      payload: { steps: [{ kind: "action", renderedSentence: "missing verbOpKey" }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("malformed path-param uuid -> 400, not 500", () => {
  // The descriptors declare `z.string().uuid()` for caseId/projectId; the route helper
  // must enforce it via `schema.params`, so a non-uuid id is rejected at the edge (400)
  // instead of reaching Postgres, which throws `invalid input syntax for type uuid` and
  // surfaces as a raw 500 that leaks the SQL in the log.
  it("GET /v1/cases/{caseId} with a non-uuid id -> 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/cases/not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
    expect(res.json<{ code: string }>().code).toBe("VALIDATION_FAILED");
  });

  it("PUT /v1/cases/{caseId}/steps with a non-uuid id -> 400 (before the If-Match/DB path)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/cases/12345/steps",
      headers: { "if-match": '"1"' },
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });

  it("POST /v1/projects/{projectId}/cases with a non-uuid projectId -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects/not-a-uuid/cases",
      payload: { name: "C", isStepGroup: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.statusCode).not.toBe(500);
  });
});
