/**
 * Composition root TƯỜNG MINH (~150 dòng khi hoàn thiện) — không DI container.
 *
 * Wiring theo DAG một chiều:
 *   kernel → identity, governance → verbs | elements | testdata
 *          → authoring → planning → orchestration → results
 *   edge (integrations, ai, mcp-gateway) chỉ phụ thuộc vào trong.
 *
 * Gọi ngược/ngang = domain event qua transactional outbox (krn_outbox,
 * ghi cùng transaction Postgres) → relay → BullMQ events → handler idempotent.
 * `import ... from "bullmq"` bị lint CẤM ngoài kernel/relay/dispatcher.
 */
import { createDb, type KernelEnv } from "./modules/kernel/index.js";
import { createAuthenticator, createAuthzCache } from "./modules/identity/index.js";
import { identityRouteRegistrations } from "./modules/identity/routes.js";
import { buildHttpApp, type TkApp } from "./http/app.js";

export async function buildApp(env: KernelEnv): Promise<TkApp> {
  const { db, close } = createDb(env);
  const cache = createAuthzCache({});
  const authenticator = createAuthenticator({ db, cache });

  const app = await buildHttpApp({
    env,
    db,
    authenticator,
    registrations: [
      ...identityRouteRegistrations({ db }),
      // authoring nối registration của nó vào đây (một dòng, sau identity).
    ],
  });

  app.addHook("onClose", async () => {
    await close();
  });
  return app;
}
