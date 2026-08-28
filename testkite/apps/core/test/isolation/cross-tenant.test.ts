/**
 * L3 — the tenant-isolation harness generated from the OpenAPI contract (blueprint §3, T4 non-negotiable).
 *
 * Rule: team B's token + team A's id ⇒ **404**, NEVER 403.
 * Why not 403: a 403 confirms "this resource exists" — that's already a leak. To team B,
 * team A's resource simply does not exist.
 *
 * This is NOT a hand-written list: it reads `ROUTES` and generates one case per
 * (route × path param). Adding a route and forgetting its fixture ⇒ `coverage.test.ts`
 * goes red; adding a route and forgetting its descriptor ⇒ the "real router" test at the
 * end of this file goes red.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { ROUTES, pathParamNames, toFastifyPath } from "@testkite/contract";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { BODY_FIXTURES, EXEMPT, RESOURCE_FIXTURES } from "./fixtures.js";

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

const TARGETS = ROUTES.filter(
  (r) => pathParamNames(r.path).length > 0 && EXEMPT[r.operationId] === undefined,
);

/**
 * Global Constraint: `teamId` is only ever born from an authenticated credential.
 *
 * The plan states this rule as one blanket negative ("no route accepts teamId"), but that
 * very plan (Task 8) has `loginPassword` accept `teamId` in its body — and that's not a
 * contradiction: login is where the credential IS BORN, so there is no tenant yet to
 * overwrite, and `teamId` there only picks among the memberships OF THE PERSON WHO JUST
 * PROVED their password (requesting a team they don't belong to ⇒ 401, see
 * `login.test.ts`). So the gate below splits the rule into two halves and is STRICTER than
 * a single blanket negative:
 *   - an `auth: "required"` route (already has a `RequestContext`): absolutely no teamId,
 *     anywhere — path, query, or body;
 *   - a public route: only an operationId in the allowlist below, WITH A REASON, may
 *     accept teamId in its body. Adding a new public route that accepts teamId ⇒ CI goes red.
 * Path params and query have NO exception, not even on a public route.
 */
const TEAM_SELECTOR_PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  loginPassword:
    "picks a team among the memberships of the person who just authenticated with a password — no credential exists yet so there is no tenant to overwrite; requesting a team you don't belong to ⇒ 401 (not 403, doesn't confirm the team is real)",
};

/**
 * Key used to compare the REAL router against the descriptor. HEAD is normalized to GET:
 * Fastify auto-generates a HEAD for every GET (`exposeHeadRoutes` defaults to true) from
 * the GET's OWN route options — same `config.tk`, same auth hook, same permission — while
 * OpenAPI never describes HEAD. Normalized (rather than skipped) so a HEAD with no GET
 * twin still gets caught as a rogue route.
 */
function declaredKey(method: string, url: string): string {
  return method === "HEAD" ? `GET ${url}` : `${method} ${url}`;
}

function bodyShapeKeys(body: unknown): readonly string[] {
  const shape = (body as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape === undefined ? [] : Object.keys(shape);
}

describe("L3 tenant isolation (generated from ROUTES)", () => {
  it("there are routes to check — an empty list means this test suite is useless", () => {
    expect(TARGETS.length).toBeGreaterThan(0);
  });

  for (const r of TARGETS) {
    it(`${r.method.toUpperCase()} ${r.path} — team B's token + team A's id ⇒ 404`, async () => {
      // 1. Build a REAL resource belonging to team A.
      let url = toFastifyPath(r.path);
      for (const name of pathParamNames(r.path)) {
        const make = RESOURCE_FIXTURES[name];
        // Throw (not just expect) so the url never proceeds with an unreplaced `:param` —
        // the route would return 400 and hide the 404-vs-403 question.
        if (make === undefined) {
          throw new Error(`missing RESOURCE_FIXTURES["${name}"] for ${r.operationId}`);
        }
        url = url.replace(`:${name}`, await make({ app: h }));
      }

      // 2. Call it with TEAM B's credential.
      // `BODY_FIXTURES` is declared `unknown` (each module submits its own body); narrow
      // it here instead of casting — a missing fixture already turned coverage.test.ts red.
      const fixture = BODY_FIXTURES[r.operationId];
      const payload = typeof fixture === "object" && fixture !== null ? { payload: fixture } : {};
      const res = await h.app.inject({
        method: r.method.toUpperCase() as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        url,
        headers: { authorization: `Bearer ${h.tokens.adminB}` },
        ...(r.body !== undefined ? payload : {}),
      });

      // 3. The verdict.
      expect(res.statusCode, `${r.operationId}: 403 is a LEAK — must be 404`).not.toBe(403);
      expect(res.statusCode, `${r.operationId} returned ${res.statusCode}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    });
  }

  it("the 404 for another team's resource is IDENTICAL to the 404 for a nonexistent id (indistinguishable)", async () => {
    const makeToken = RESOURCE_FIXTURES["tokenId"];
    if (makeToken === undefined) throw new Error("fixture tokenId is gone");
    const tokenA = await makeToken({ app: h });
    const foreign = await h.app.inject({
      method: "DELETE",
      url: `/v1/tokens/${tokenA}`,
      headers: { authorization: `Bearer ${h.tokens.adminB}` },
    });
    const ghost = await h.app.inject({
      method: "DELETE",
      url: "/v1/tokens/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${h.tokens.adminB}` },
    });
    const strip = (b: string): string => b.replace(/"requestId":"[^"]+"/, '"requestId":"X"');
    expect(strip(foreign.body)).toBe(strip(ghost.body));
    expect(foreign.statusCode).toBe(ghost.statusCode);
  });

  it("a LIST route never returns another team's rows", async () => {
    const listB = await h.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: { authorization: `Bearer ${h.tokens.adminB}` },
    });
    expect(listB.statusCode).toBe(200);
    const bodyB = listB.json() as { id: string }[];
    expect(bodyB.length).toBeGreaterThan(0);
    const idsA = await h.db.raw.query<{ id: string }>(
      `SELECT id FROM api_tokens WHERE team_id=$1`,
      [h.ids.teamA],
    );
    expect(idsA.rows.length).toBeGreaterThan(0);
    const setA = new Set(idsA.rows.map((x) => x.id));
    for (const row of bodyB) expect(setA.has(row.id)).toBe(false);
  });

  it("every /v1 route the REAL ROUTER is serving has a contract descriptor", () => {
    // A route registered as a FastifyPluginAsync (plan authoring) doesn't automatically
    // land in ROUTES. Missing a descriptor = invisible to OpenAPI AND to this very test suite ⇒ a false green.
    const live = h.app.tkRegisteredRoutes.filter((r) => r.url.startsWith("/v1"));
    expect(live.length).toBeGreaterThan(0);
    const noDescriptor = live.filter((r) => !r.hasDescriptor).map((r) => `${r.method} ${r.url}`);
    expect(
      noDescriptor,
      "declare a descriptor in packages/contract/src/routes/ and put it in config.tk",
    ).toEqual([]);
    const declared = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${toFastifyPath(r.path)}`));
    const orphan = live
      .filter((r) => !declared.has(declaredKey(r.method, r.url)))
      .map((r) => `${r.method} ${r.url}`);
    expect(orphan, "route has config.tk but its descriptor is not in ROUTES").toEqual([]);
  });

  it("an auto-generated HEAD route SHARES the descriptor of its GET (not a back door)", () => {
    // Fastify enables `exposeHeadRoutes` by default: every GET comes with a HEAD that uses
    // the GET's EXACT route options — same `config.tk`, so the same auth hook, same
    // permission. It's not in ROUTES because OpenAPI never describes HEAD, and the test
    // above normalizes it to GET for comparison. This test keeps that normalization valid:
    // a HEAD with no GET twin carrying a descriptor is a rogue route, not a Fastify shadow.
    const live = h.app.tkRegisteredRoutes.filter((r) => r.url.startsWith("/v1"));
    const getWithDescriptor = new Set(
      live.filter((r) => r.method === "GET" && r.hasDescriptor).map((r) => r.url),
    );
    const lone = live
      .filter((r) => r.method === "HEAD" && !getWithDescriptor.has(r.url))
      .map((r) => r.url);
    expect(lone, "a HEAD with no matching GET ⇒ not a Fastify shadow route").toEqual([]);
  });

  it("every descriptor in ROUTES is served by the REAL router (no dead contract)", () => {
    // The reverse of the test above: a descriptor exists in OpenAPI but no route serves it
    // ⇒ the docs are lying, and the L3 harness above would be testing a URL that returns
    // 404 because it DOESN'T EXIST, not because of tenant isolation — the worst kind of false green.
    const live = new Set(
      h.app.tkRegisteredRoutes
        .filter((r) => r.url.startsWith("/v1"))
        .map((r) => `${r.method} ${r.url}`),
    );
    const dead = ROUTES.filter(
      (r) => !live.has(`${r.method.toUpperCase()} ${toFastifyPath(r.path)}`),
    ).map((r) => r.operationId);
    expect(dead, "descriptor has no handler serving it").toEqual([]);
  });

  it("no route accepts teamId from the client (no way to override the tenant)", () => {
    for (const r of ROUTES) {
      expect(pathParamNames(r.path), `${r.operationId} accepts teamId in the path`).not.toContain(
        "teamId",
      );
      expect(
        Object.keys(r.query?.shape ?? {}),
        `${r.operationId} accepts teamId in the query`,
      ).not.toContain("teamId");
      const bodyKeys = bodyShapeKeys(r.body);
      if (r.auth === "required" || TEAM_SELECTOR_PUBLIC_ROUTES[r.operationId] === undefined) {
        expect(bodyKeys, `${r.operationId} accepts teamId in the body`).not.toContain("teamId");
      }
    }
  });

  it("the teamId allowlist only contains live public routes, each with a written reason", () => {
    for (const [op, reason] of Object.entries(TEAM_SELECTOR_PUBLIC_ROUTES)) {
      const r = ROUTES.find((x) => x.operationId === op);
      expect(r, `${op} no longer exists — remove it from the allowlist`).toBeDefined();
      expect(r?.auth, `${op} now requires auth — remove the teamId exception`).toBe("public");
      expect(reason.length, `${op}: reason is too short`).toBeGreaterThan(30);
      // The exception only makes sense while the route ACTUALLY still accepts teamId; otherwise it's dead weight.
      expect(bodyShapeKeys(r?.body), `${op} no longer accepts teamId — remove it from the allowlist`).toContain(
        "teamId",
      );
    }
  });
});
