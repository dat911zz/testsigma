/**
 * L3 — bộ cách ly tenant sinh từ hợp đồng OpenAPI (blueprint §3, T4 không thương lượng).
 *
 * Luật: token của team B + id của team A ⇒ **404**, KHÔNG BAO GIỜ 403.
 * Vì sao không 403: 403 xác nhận "tài nguyên này có tồn tại" — đó đã là rò rỉ. Với
 * team B thì tài nguyên của team A đơn giản là không tồn tại.
 *
 * Đây KHÔNG phải danh sách viết tay: nó đọc `ROUTES` và sinh một case cho mỗi
 * (route × path param). Thêm route mà quên fixture ⇒ `coverage.test.ts` đỏ; thêm route
 * mà quên descriptor ⇒ test "router thật" ở cuối file đỏ.
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
 * Global Constraint: `teamId` chỉ ra đời từ credential đã xác thực.
 *
 * Plan viết luật này thành một dòng phủ định ("không route nào nhận teamId"), nhưng
 * chính plan ấy (Task 8) cho `loginPassword` nhận `teamId` trong body — và đó không
 * phải mâu thuẫn: login là nơi credential RA ĐỜI, lúc đó chưa có tenant nào để ghi
 * đè, còn `teamId` ở đó chỉ chọn giữa các membership CỦA CHÍNH người vừa chứng minh
 * mật khẩu (xin team mình không thuộc về ⇒ 401, `login.test.ts`). Nên gate dưới đây
 * tách hai vế và CHẶT HƠN một dòng phủ định đơn giản:
 *   - route `auth: "required"` (đã có `RequestContext`): tuyệt đối không teamId, ở
 *     bất kỳ đâu — path, query hay body;
 *   - route public: chỉ operationId nằm trong allowlist CÓ LÝ DO dưới đây mới được
 *     nhận teamId trong body. Thêm route public mới nhận teamId ⇒ CI đỏ.
 * Path param và query thì KHÔNG có ngoại lệ nào, kể cả route public.
 */
const TEAM_SELECTOR_PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  loginPassword:
    "chọn team giữa các membership của chính người vừa xác thực mật khẩu — credential chưa tồn tại nên không có tenant nào bị ghi đè; xin team mình không thuộc về ⇒ 401 (không phải 403, không xác nhận team có thật)",
};

/**
 * Khoá để so route THẬT với descriptor. HEAD được quy về GET: Fastify tự sinh HEAD cho
 * mỗi GET (`exposeHeadRoutes` mặc định true) từ CHÍNH route options của GET — cùng
 * `config.tk`, cùng hook auth, cùng permission — còn OpenAPI thì không tả HEAD bao giờ.
 * Quy về (chứ không bỏ qua) để HEAD nào không có GET song sinh vẫn bị bắt là route lậu.
 */
function declaredKey(method: string, url: string): string {
  return method === "HEAD" ? `GET ${url}` : `${method} ${url}`;
}

function bodyShapeKeys(body: unknown): readonly string[] {
  const shape = (body as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape === undefined ? [] : Object.keys(shape);
}

describe("cách ly tenant L3 (sinh từ ROUTES)", () => {
  it("có route để kiểm — danh sách rỗng nghĩa là bộ test này vô dụng", () => {
    expect(TARGETS.length).toBeGreaterThan(0);
  });

  for (const r of TARGETS) {
    it(`${r.method.toUpperCase()} ${r.path} — token team B + id team A ⇒ 404`, async () => {
      // 1. Dựng tài nguyên THẬT thuộc team A.
      let url = toFastifyPath(r.path);
      for (const name of pathParamNames(r.path)) {
        const make = RESOURCE_FIXTURES[name];
        // Ném (không chỉ expect) để url không bao giờ đi tiếp với `:param` chưa thay —
        // route sẽ trả 400 và che mất câu hỏi 404-hay-403.
        if (make === undefined) {
          throw new Error(`thiếu RESOURCE_FIXTURES["${name}"] cho ${r.operationId}`);
        }
        url = url.replace(`:${name}`, await make({ app: h }));
      }

      // 2. Gọi bằng credential của TEAM B.
      // `BODY_FIXTURES` khai kiểu `unknown` (mỗi module nộp body của mình); thu hẹp về
      // object ở đây thay vì cast — thiếu fixture thì coverage.test.ts đã đỏ trước rồi.
      const fixture = BODY_FIXTURES[r.operationId];
      const payload = typeof fixture === "object" && fixture !== null ? { payload: fixture } : {};
      const res = await h.app.inject({
        method: r.method.toUpperCase() as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        url,
        headers: { authorization: `Bearer ${h.tokens.adminB}` },
        ...(r.body !== undefined ? payload : {}),
      });

      // 3. Phán quyết.
      expect(res.statusCode, `${r.operationId}: 403 là RÒ RỈ — phải 404`).not.toBe(403);
      expect(res.statusCode, `${r.operationId} trả ${res.statusCode}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    });
  }

  it("404 của tài nguyên team khác GIỐNG HỆT 404 của id không tồn tại (không phân biệt được)", async () => {
    const makeToken = RESOURCE_FIXTURES["tokenId"];
    if (makeToken === undefined) throw new Error("fixture tokenId biến mất");
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

  it("route LIST không bao giờ trả row của team khác", async () => {
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

  it("mọi route /v1 mà ROUTER THẬT đang phục vụ đều có descriptor hợp đồng", () => {
    // Route đăng ký kiểu FastifyPluginAsync (plan authoring) không tự vào ROUTES.
    // Thiếu descriptor = vô hình với OpenAPI VÀ với chính bộ test này ⇒ xanh giả.
    const live = h.app.tkRegisteredRoutes.filter((r) => r.url.startsWith("/v1"));
    expect(live.length).toBeGreaterThan(0);
    const noDescriptor = live.filter((r) => !r.hasDescriptor).map((r) => `${r.method} ${r.url}`);
    expect(
      noDescriptor,
      "khai descriptor trong packages/contract/src/routes/ và đặt vào config.tk",
    ).toEqual([]);
    const declared = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${toFastifyPath(r.path)}`));
    const orphan = live
      .filter((r) => !declared.has(declaredKey(r.method, r.url)))
      .map((r) => `${r.method} ${r.url}`);
    expect(orphan, "route có config.tk nhưng descriptor không nằm trong ROUTES").toEqual([]);
  });

  it("route HEAD tự sinh dùng CHUNG descriptor với GET của nó (không phải cửa sau)", () => {
    // Fastify bật `exposeHeadRoutes` mặc định: mỗi GET kèm một HEAD dùng ĐÚNG route
    // options của GET — cùng `config.tk` nên cùng hook auth, cùng permission. Nó không
    // nằm trong ROUTES vì OpenAPI không tả HEAD, và test trên quy nó về GET để so.
    // Test này giữ cho phép quy đó luôn đúng: HEAD nào không có GET song sinh mang
    // descriptor thì là route lậu, không phải shadow.
    const live = h.app.tkRegisteredRoutes.filter((r) => r.url.startsWith("/v1"));
    const getWithDescriptor = new Set(
      live.filter((r) => r.method === "GET" && r.hasDescriptor).map((r) => r.url),
    );
    const lone = live
      .filter((r) => r.method === "HEAD" && !getWithDescriptor.has(r.url))
      .map((r) => r.url);
    expect(lone, "HEAD không có GET tương ứng ⇒ không phải shadow của Fastify").toEqual([]);
  });

  it("mọi descriptor trong ROUTES đều được router THẬT phục vụ (không có hợp đồng chết)", () => {
    // Chiều ngược của test trên: descriptor có trong OpenAPI nhưng không route nào
    // phục vụ ⇒ tài liệu nói dối, và bộ L3 ở trên thì test một URL trả 404 vì KHÔNG
    // TỒN TẠI chứ không phải vì cách ly tenant — xanh giả kiểu tệ nhất.
    const live = new Set(
      h.app.tkRegisteredRoutes
        .filter((r) => r.url.startsWith("/v1"))
        .map((r) => `${r.method} ${r.url}`),
    );
    const dead = ROUTES.filter(
      (r) => !live.has(`${r.method.toUpperCase()} ${toFastifyPath(r.path)}`),
    ).map((r) => r.operationId);
    expect(dead, "descriptor không có handler nào phục vụ").toEqual([]);
  });

  it("không route nào chấp nhận teamId từ client (không có đường ghi đè tenant)", () => {
    for (const r of ROUTES) {
      expect(pathParamNames(r.path), `${r.operationId} nhận teamId trong path`).not.toContain(
        "teamId",
      );
      expect(
        Object.keys(r.query?.shape ?? {}),
        `${r.operationId} nhận teamId trong query`,
      ).not.toContain("teamId");
      const bodyKeys = bodyShapeKeys(r.body);
      if (r.auth === "required" || TEAM_SELECTOR_PUBLIC_ROUTES[r.operationId] === undefined) {
        expect(bodyKeys, `${r.operationId} nhận teamId trong body`).not.toContain("teamId");
      }
    }
  });

  it("allowlist teamId chỉ chứa route public còn sống, kèm lý do bằng chữ", () => {
    for (const [op, reason] of Object.entries(TEAM_SELECTOR_PUBLIC_ROUTES)) {
      const r = ROUTES.find((x) => x.operationId === op);
      expect(r, `${op} không còn tồn tại — xoá khỏi allowlist`).toBeDefined();
      expect(r?.auth, `${op} đã thành route có xác thực — bỏ ngoại lệ teamId đi`).toBe("public");
      expect(reason.length, `${op}: lý do quá ngắn`).toBeGreaterThan(30);
      // Ngoại lệ chỉ có nghĩa khi route THẬT SỰ còn nhận teamId; nếu không, nó là rác.
      expect(bodyShapeKeys(r?.body), `${op} không còn nhận teamId — xoá khỏi allowlist`).toContain(
        "teamId",
      );
    }
  });
});
