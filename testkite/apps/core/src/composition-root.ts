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
import { writeAuditEvent } from "./modules/governance/index.js";
import { governanceRouteRegistrations } from "./modules/governance/routes.js";
import { authoringRoutes } from "./modules/authoring/index.js";
import { onboardRouteRegistration } from "./http/usecases/onboard-team.js";
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
      // `audit`: identity KHÔNG được import governance (cùng tầng DAG) — tầng shell
      // là nơi duy nhất biết cả hai, nên phép nối hai module xảy ra ở ĐÂY.
      ...identityRouteRegistrations({ db, cache, audit: writeAuditEvent }),
      ...governanceRouteRegistrations({ db }),
      // Onboarding chạm bảng của BỐN module trong một transaction ⇒ use case (và cả
      // registration của nó) sống ở tầng shell, không ở module identity.
      onboardRouteRegistration({ db }),
    ],
    // authoring registers as a FastifyPluginAsync (its own routes carry `config.tk`);
    // buildHttpApp mounts plugins AFTER the auth hook so it covers them too.
    plugins: [authoringRoutes(db)],
  });

  app.addHook("onClose", async () => {
    await close();
  });
  return app;
}
