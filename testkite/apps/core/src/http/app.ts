/**
 * Bootstrap Fastify 5 — thuộc TẦNG SHELL (ngoài DAG 12 module, như composition-root).
 * Module nghiệp vụ không bao giờ import file này; nó chỉ NỘP route registration.
 *
 * Vì sao fastify-type-provider-zod 4.0.2 (pin exact): spike 2026-08-28 — bản 5+
 * nói dialect `zod/v4`, còn @testkite/contract viết bằng zod v3 classic; ghép sai
 * cặp thì mọi request trả 500 "Cannot read properties of undefined".
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { toFastifyPath, UnauthorizedError } from "@testkite/contract";
import type { KernelEnv, TkDb } from "../modules/kernel/index.js";
import type { Authenticator } from "../modules/identity/index.js";
import { installAuth } from "./auth.js";
import { installErrorHandler } from "./errors.js";
import type { RouteRegistration } from "./types.js";

export type TkApp = FastifyInstance;

export type HttpDeps = {
  readonly env: KernelEnv;
  readonly db: TkDb;
  readonly authenticator: Authenticator;
  readonly registrations: readonly RouteRegistration[];
  /**
   * Cửa cho module đăng ký kiểu `FastifyPluginAsync` (plan authoring dùng kiểu này).
   * Chúng được `register` SAU `installAuth` nên hook auth phủ cả route của plugin —
   * điều kiện duy nhất: mỗi route của plugin PHẢI mang descriptor ở `config.tk`.
   */
  readonly plugins?: readonly FastifyPluginAsync[];
};

export async function buildHttpApp(deps: HttpDeps): Promise<TkApp> {
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL },
    genReqId: () => randomUUID(),
    // Không tin proxy mù quáng; bật khi có reverse proxy nội bộ (M6 hardening).
    trustProxy: false,
    // Chặn body khổng lồ ngay ở cổng — hệ cũ chết vì multipart 500MB (blueprint §1).
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  // Sổ route THẬT của router. Bộ L3 (Task 11) dùng nó để bắt route đăng ký kiểu
  // plugin mà quên khai descriptor — thứ sẽ vô hình với OpenAPI lẫn test cách ly.
  // Cài TRƯỚC route đầu tiên: hook onRoute chỉ thấy route đăng ký sau nó.
  const registered: { method: string; url: string; hasDescriptor: boolean }[] = [];
  app.decorate("tkRegisteredRoutes", registered);
  app.addHook("onRoute", (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    const cfg = opts.config;
    for (const m of methods) registered.push({ method: m, url: opts.url, hasDescriptor: cfg?.tk !== undefined });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  installAuth(app, { authenticator: deps.authenticator });

  for (const reg of deps.registrations) {
    const d = reg.descriptor;
    const codes = Object.keys(d.responses).map(Number);
    app.withTypeProvider<ZodTypeProvider>().route({
      method: d.method.toUpperCase() as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      url: toFastifyPath(d.path),
      // Hook auth đọc chính descriptor này — hợp đồng và cưỡng chế không thể lệch nhau.
      config: { tk: d },
      schema: {
        ...(d.params !== undefined ? { params: d.params } : {}),
        ...(d.query !== undefined ? { querystring: d.query } : {}),
        ...(d.body !== undefined ? { body: d.body } : {}),
        response: d.responses,
      },
      handler: async (req, reply) => {
        const input = {
          params: req.params as never,
          query: req.query as never,
          body: req.body as never,
        };
        // Route public (login, oidc callback) chạy KHI CHƯA có credential — nó không
        // nhận `ctx` bao giờ, nên không có đường nào để tenant rò vào từ chỗ khác.
        // Route required: hook onRequest đã chặn mọi request không có credential; tới
        // đây mà ctx vẫn null nghĩa là hook không chạy ⇒ đóng cửa, không đoán.
        let result: unknown;
        if (reg.auth === "public") {
          result = await reg.handler(input);
        } else {
          const ctx = req.tk;
          if (ctx === null) throw new UnauthorizedError("thiếu bối cảnh xác thực");
          result = await reg.handler({ ctx, ...input });
        }
        const status = codes.includes(201) ? 201 : codes.includes(204) ? 204 : 200;
        return reply.code(status).send(result);
      },
    });
  }

  // Module đăng ký kiểu FastifyPluginAsync (plan authoring dùng kiểu này) vào SAU —
  // hook auth ở trên đã cài nên nó phủ cả route của plugin. Plugin vẫn PHẢI đặt
  // descriptor vào `config: { tk }` của từng route, nếu không Task 11 sẽ đỏ.
  for (const plugin of deps.plugins ?? []) {
    await app.register(plugin);
  }

  return app;
}
