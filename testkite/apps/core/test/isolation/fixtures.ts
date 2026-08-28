/**
 * Fixtures for the L3 isolation harness. EACH module submits fixtures for its own path params:
 *   - RESOURCE_FIXTURES[<param name>]  -> creates a resource OWNED BY TEAM A, returns its id
 *   - BODY_FIXTURES[<operationId>]     -> a valid body (if the route has one)
 * Missing either one ⇒ coverage.test.ts goes red. There is no silent way to skip it.
 *
 * A fixture should create its resource through the REAL product path whenever possible
 * (call the actual route with team A's credential). Only reach straight for SQL when no
 * route can create that resource yet.
 */
import type { TestApp } from "../harness/http.js";

export type FixtureCtx = { readonly app: TestApp };

export const RESOURCE_FIXTURES: Readonly<Record<string, (c: FixtureCtx) => Promise<string>>> = {
  // --- identity ---
  tokenId: async ({ app }) => {
    const r = await app.app.inject({
      method: "POST",
      url: "/v1/tokens",
      headers: { authorization: `Bearer ${app.tokens.adminA}` },
      payload: { name: "fixture", scopes: ["case:read"], expiresInDays: 30 },
    });
    if (r.statusCode !== 201) throw new Error(`fixture tokenId failed: ${r.statusCode} ${r.body}`);
    return (r.json() as { id: string }).id;
  },
  userId: async ({ app }) => app.ids.authorUser,
  connectorId: async ({ app }) => {
    const r = await app.db.raw.query<{ id: string }>(
      `INSERT INTO idn_oidc_connectors (team_id,name,issuer_url,client_id,client_secret,scopes,default_role,allow_insecure_http)
       VALUES ($1,'fixture','http://127.0.0.1:1/x','c','s',ARRAY['openid'],'viewer',true) RETURNING id`,
      [app.ids.teamA],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) throw new Error("fixture connectorId failed: INSERT returned no id");
    return id;
  },
  // --- authoring ---
  // A project owned by team A. POST /v1/projects/{projectId}/cases with team B's token
  // must yield 404 (the project is invisible), never a leak that it exists elsewhere.
  projectId: async ({ app }) => app.ids.projectA,
  // A case owned by team A, created through the real product route with an author of
  // team A (author role carries case:write). Every /v1/cases/{caseId} route is then
  // probed with team B's token and must return 404.
  caseId: async ({ app }) => {
    const r = await app.app.inject({
      method: "POST",
      url: `/v1/projects/${app.ids.projectA}/cases`,
      headers: { authorization: `Bearer ${app.tokens.authorA}` },
      payload: { name: "L3 fixture", isStepGroup: false },
    });
    if (r.statusCode !== 201) throw new Error(`fixture caseId failed: ${r.statusCode} ${r.body}`);
    return (r.json() as { id: string }).id;
  },
};

export const BODY_FIXTURES: Readonly<Record<string, unknown>> = {
  setMemberRole: { role: "viewer" },
  oidcStart: { redirectUri: "http://127.0.0.1:8080/cb" },
  oidcCallback: { callbackUrl: "http://127.0.0.1:8080/cb?code=x&state=y" },
  // Valid authoring bodies so the L3 probe reaches the tenant check (404) instead of
  // stopping at body validation (400), which would hide the 404-vs-403 question.
  createCase: { name: "L3", isStepGroup: false },
  replaceSteps: { steps: [] },
  reviewCase: { decision: "approved" },
};

/**
 * An exemption MUST have a written reason, and the reason must be one of two kinds:
 * (a) the route reads/writes no tenant resource by id, (b) it's a public route with no
 * credential yet, so the notion of "team B's token" doesn't apply.
 */
export const EXEMPT: Readonly<Record<string, string>> = {
  oidcStart:
    "public route — no credential yet, so there is no 'team B token'; connector isolation is tested separately in oidc.test.ts",
  oidcCallback: "public route — same as above; single-use state + the composite FK are the enforcement layer",
};
