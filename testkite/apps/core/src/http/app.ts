/**
 * Bootstraps Fastify 5 — belongs to the SHELL LAYER (outside the 12-module DAG, like the
 * composition root). Business modules never import this file; they only SUBMIT route registrations.
 *
 * Why fastify-type-provider-zod 4.0.2 (pinned exact): spike 2026-08-28 — 5+ speaks the
 * `zod/v4` dialect, while @testkite/contract is written in classic zod v3; pairing the
 * wrong versions makes every request return 500 "Cannot read properties of undefined".
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { toFastifyPath, UnauthorizedError } from "@testkite/contract";
import type { KernelEnv, TkDb } from "../modules/kernel/index.js";
import type { Authenticator } from "../modules/identity/index.js";
import { installAuth } from "./auth.js";
import { installErrorHandler } from "./errors.js";
import { LOG_SERIALIZERS } from "./log-serializers.js";
import type { RouteRegistration } from "./types.js";

export type TkApp = FastifyInstance;

export type HttpDeps = {
  readonly env: KernelEnv;
  readonly db: TkDb;
  readonly authenticator: Authenticator;
  readonly registrations: readonly RouteRegistration[];
  /**
   * A door for modules that register routes as a `FastifyPluginAsync` (plan authoring uses
   * this style). They are `register`ed AFTER `installAuth`, so the auth hook covers the
   * plugin's routes too — the one requirement: every plugin route MUST carry a descriptor
   * in `config.tk`.
   */
  readonly plugins?: readonly FastifyPluginAsync[];
};

export async function buildHttpApp(deps: HttpDeps): Promise<TkApp> {
  const app = Fastify({
    // `serializers.err` is not cosmetic: the error handler logs the whole error on a 500, and
    // a DrizzleQueryError carries the full SQL plus every bound value. See log-serializers.ts.
    logger: { level: deps.env.LOG_LEVEL, serializers: LOG_SERIALIZERS },
    genReqId: () => randomUUID(),
    // Don't blindly trust the proxy; enable once there's an internal reverse proxy (M6 hardening).
    trustProxy: false,
    // Block oversized bodies right at the gate — the legacy system died from 500MB multipart uploads (blueprint §1).
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  // The router's REAL route ledger. The L3 harness (Task 11) uses it to catch a
  // plugin-style route that forgot to declare a descriptor — one that would be invisible
  // to both OpenAPI and the isolation tests. Installed BEFORE the first route: the onRoute
  // hook only sees routes registered after it.
  const registered: { method: string; url: string; hasDescriptor: boolean }[] = [];
  app.decorate("tkRegisteredRoutes", registered);
  // Declared here, set only by the composition root: a test app has no fleet plane, and `null`
  // says so honestly instead of leaving the property missing behind a type that promises it.
  app.decorate("tkFleet", null);
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
      // The auth hook reads this exact descriptor — the contract and its enforcement can never drift apart.
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
        // A public route (login, oidc callback) runs BEFORE any credential exists — it
        // never receives `ctx`, so there's no path for a tenant to leak in from elsewhere.
        // A required route: the onRequest hook already blocked every request without a
        // credential; if ctx is still null here, the hook didn't run ⇒ close the door, don't guess.
        let result: unknown;
        if (reg.auth === "public") {
          result = await reg.handler(input);
        } else {
          const ctx = req.tk;
          if (ctx === null) throw new UnauthorizedError("missing auth context");
          result = await reg.handler({ ctx, ...input });
        }
        const status = codes.includes(201) ? 201 : codes.includes(204) ? 204 : 200;
        return reply.code(status).send(result);
      },
    });
  }

  // Modules that register as a FastifyPluginAsync (plan authoring uses this style) go in
  // AFTER — the auth hook installed above already covers the plugin's routes too. A
  // plugin still MUST put a descriptor in each route's `config: { tk }`, otherwise Task 11 will fail.
  for (const plugin of deps.plugins ?? []) {
    await app.register(plugin);
  }

  return app;
}
