/**
 * Bootstrap Fastify 5 — thuộc TẦNG SHELL (ngoài DAG 12 module, như composition-root).
 * Module nghiệp vụ không bao giờ import file này; nó chỉ NỘP route registration.
 *
 * Vì sao fastify-type-provider-zod 4.0.2 (pin exact): spike 2026-08-28 — bản 5+
 * nói dialect `zod/v4`, còn @testkite/contract viết bằng zod v3 classic; ghép sai
 * cặp thì mọi request trả 500 "Cannot read properties of undefined".
 */
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { KernelEnv, TkDb } from "../modules/kernel/index.js";
import { installErrorHandler } from "./errors.js";

export type TkApp = FastifyInstance;

export type HttpDeps = {
  readonly env: KernelEnv;
  readonly db: TkDb;
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

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
