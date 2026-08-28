/**
 * Fixture cho bộ cách ly L3. MỖI module nộp fixture cho path param của mình:
 *   - RESOURCE_FIXTURES[<tên param>]  -> tạo tài nguyên THUỘC TEAM A, trả id
 *   - BODY_FIXTURES[<operationId>]    -> body hợp lệ (nếu route có body)
 * Thiếu một trong hai ⇒ coverage.test.ts đỏ. Không có đường im lặng bỏ qua.
 *
 * Fixture phải tạo tài nguyên bằng ĐÚNG đường sản phẩm khi có thể (gọi route thật với
 * credential của team A). Chỉ đi thẳng SQL khi chưa có route nào tạo được thứ đó.
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
    if (r.statusCode !== 201) throw new Error(`fixture tokenId hỏng: ${r.statusCode} ${r.body}`);
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
    if (id === undefined) throw new Error("fixture connectorId hỏng: INSERT không trả id");
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
 * Miễn trừ PHẢI có lý do bằng chữ, và lý do phải là một trong hai loại:
 * (a) route không đọc/ghi tài nguyên tenant nào theo id, (b) route public chưa có
 * credential nên khái niệm "token team B" không tồn tại.
 */
export const EXEMPT: Readonly<Record<string, string>> = {
  oidcStart:
    "route public — chưa có credential nên không tồn tại 'token team B'; cách ly connector test riêng ở oidc.test.ts",
  oidcCallback: "route public — như trên; state một-lần + composite FK là lớp chặn",
};
