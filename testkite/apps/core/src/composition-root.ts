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
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { createDb, type KernelEnv } from "./modules/kernel/index.js";
import { createAuthenticator, createAuthzCache } from "./modules/identity/index.js";
import { identityRouteRegistrations } from "./modules/identity/routes.js";
import { writeAuditEvent } from "./modules/governance/index.js";
import { governanceRouteRegistrations } from "./modules/governance/routes.js";
import { authoringRoutes } from "./modules/authoring/index.js";
import {
  orchestrationRoutes,
  startDispatcher,
  type DispatcherHooks,
  type StartRunDeps,
} from "./modules/orchestration/index.js";
import { onboardRouteRegistration } from "./http/usecases/onboard-team.js";
import { buildInternalApp } from "./http/internal/app.js";
import { buildHttpApp, type TkApp } from "./http/app.js";

/**
 * Phase 0's two loaders. `elements` and `testdata` sit before authoring in the DAG but their
 * facades are still empty (both modules land in M4), so every element id resolves to "unknown"
 * for now: the compiler answers with an `element_not_found` diagnostic, the run ends as
 * `compile_error`, its quota is refunded and no browser is ever started.
 *
 * Deliberately NOT a `throw`. A 500 on POST /v1/runs would hide a feature that has not been
 * built yet behind what looks like an incident; a diagnostic names the exact step that could
 * not be resolved, through the same taxonomy every other compile failure uses.
 */
const M4_PENDING_COMPILE_DEPS: StartRunDeps = {
  loadElements: async () => ({}),
  loadDataProfiles: async () => ({}),
};

/**
 * The dispatcher's hooks, pointed at the app logger — the loop itself takes no opinion on
 * where its numbers go.
 *
 * `onTick` fires FOUR TIMES A SECOND, so a tick that did nothing is not logged: an idle
 * cluster would otherwise write ~350k lines a day and bury the two lines that matter.
 * Leadership changes and the dead-man condition are exactly those two: the dead-man means
 * nobody dispatched or reaped for a whole TTL, which is a page, not an info line.
 */
function dispatcherMetrics(log: FastifyBaseLogger): DispatcherHooks {
  return {
    onTick: (tick) => {
      if (!tick.leader) return;
      const worked = tick.dispatched > 0 || tick.reaped.requeued > 0 || tick.reaped.failed > 0;
      if (worked) log.info({ tick }, "dispatcher tick");
    },
    onLeadershipLost: (holder) => {
      log.warn({ holder }, "dispatcher: leadership lost, re-entering the election");
    },
    onDeadMan: (lease) => {
      log.error(
        { holder: lease.holder, lastTickAt: lease.lastTickAt },
        "dispatcher dead-man: the previous leader stopped ticking, the queue was unattended",
      );
    },
  };
}

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
    // buildHttpApp mounts plugins AFTER the auth hook so it covers them too. Orchestration
    // registers the same way for a second reason: its SSE route hijacks the reply, which the
    // `registrations` path (always ending in `reply.send()`) cannot express.
    plugins: [authoringRoutes(db), orchestrationRoutes(db, { compile: M4_PENDING_COMPILE_DEPS })],
  });

  // Orchestration serves TWO planes: /v1 (tenant) on the public app above, and /internal (fleet)
  // on its own port. They are separate Fastify instances on purpose — see http/internal/app.ts.
  const fleet = await buildInternalApp({
    env,
    db,
    // The plane never holds the token in clear: only its digest crosses this boundary.
    bootstrapTokenHash: createHash("sha256").update(env.FLEET_BOOTSTRAP_TOKEN).digest(),
  });
  await fleet.listen({ port: env.INTERNAL_PORT, host: env.INTERNAL_HOST });
  app.tkFleet = fleet;

  // The dispatcher is a background loop, not a request handler. Every API replica starts one;
  // the leader election decides which of them actually dispatches.
  const dispatcher = env.DISPATCHER_ENABLED
    ? startDispatcher(db, { holder: env.DISPATCHER_ID, hooks: dispatcherMetrics(app.log) })
    : null;

  app.addHook("onClose", async () => {
    await dispatcher?.stop(); // releases the lease, so the next process leads immediately
    await fleet.close();
    await close();
  });
  return app;
}
