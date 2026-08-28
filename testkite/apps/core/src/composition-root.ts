/**
 * An EXPLICIT composition root (~150 lines once finished) — no DI container.
 *
 * Wiring follows a one-way DAG:
 *   kernel → identity, governance → verbs | elements | testdata
 *          → authoring → planning → orchestration → results
 *   the edge modules (integrations, ai, mcp-gateway) only depend inward.
 *
 * Backward/sideways calls = a domain event through the transactional outbox (krn_outbox,
 * written in the same Postgres transaction) → relay → BullMQ events → an idempotent handler.
 * `import ... from "bullmq"` is lint-FORBIDDEN outside kernel/relay/dispatcher.
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
      // `audit`: identity is NOT allowed to import governance (same DAG tier) — the shell
      // tier is the only place that knows about both, so the two modules get wired together HERE.
      ...identityRouteRegistrations({ db, cache, audit: writeAuditEvent }),
      ...governanceRouteRegistrations({ db }),
      // Onboarding touches tables from FOUR modules in one transaction ⇒ the use case (and
      // its registration) lives at the shell tier, not inside the identity module.
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
