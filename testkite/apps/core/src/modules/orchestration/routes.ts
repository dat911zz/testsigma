/**
 * The PUBLIC run plane: `/v1/runs*`. Handlers do three things and nothing else — auth + scope,
 * parse, then run the service inside `withTenant`. The business lives in `run-service.ts` so it
 * can be tested without HTTP.
 *
 * Registered as a `FastifyPluginAsync` (the authoring style), NOT through `buildHttpApp`'s
 * `registrations` array, for one hard reason: `registrations` always ends in `reply.send()`,
 * and the SSE route hijacks the reply instead. Every route still stamps `config: { tk }` with
 * its contract descriptor, so the auth hook, OpenAPI and the L3 suite all read the same source.
 *
 * Cross-tenant is 404 everywhere here, never 403: `loadRunStatus`/`abortRun` answer `undefined`
 * for "not visible to this tenant", and phase 0 raises the authoring/planning NotFound errors
 * for a case or a project that belongs to somebody else.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { validatorCompiler } from "fastify-type-provider-zod";
import {
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  abortRunDescriptor,
  getRunDescriptor,
  streamRunDescriptor,
  toFastifyPath,
  triggerRunBodySchema,
  triggerRunDescriptor,
  type RouteDescriptor,
} from "@testkite/contract";
import { withTenant, type TenantContext, type TkDb } from "../kernel/index.js";
import { abortRun, loadRunStatus, startRun, type StartRunDeps } from "./run-service.js";
import { streamRun } from "./sse.js";

type MethodUpper = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The ONLY place in this module that touches the shape identity decorates a request with. It is
 * a twin of `authoring/routes/context.ts` rather than an import of it: a module reaching into
 * another module's internals is a facade violation, the helper is HTTP plumbing and not
 * authoring's domain, and reading `request.tk` structurally is precisely what keeps a business
 * module off the shell's import graph. If identity reshapes `request.tk`, fix these two files.
 */
interface DecoratedContext {
  readonly teamId: string;
  readonly userId: string | null;
  readonly scopes: readonly string[];
}

interface RequestAuth {
  readonly teamId: string;
  readonly userId: string | null;
  readonly scopes: readonly string[];
}

function authOf(request: FastifyRequest): RequestAuth {
  const ctx = (request as unknown as { tk?: DecoratedContext | null }).tk;
  // `scopes` is validated for the same reason `teamId` is: this cast is the only contact point
  // with identity's shape, so it is the only place that can notice the shape has drifted. A
  // plain STRING would answer true to `includes()` for any scope name it happens to contain.
  if (ctx === undefined || ctx === null || ctx.teamId.length === 0 || !Array.isArray(ctx.scopes)) {
    throw new UnauthorizedError(
      "request.tk is absent or malformed: the identity middleware must run before the run routes",
    );
  }
  return { teamId: ctx.teamId, userId: ctx.userId, scopes: ctx.scopes };
}

/**
 * Enforces the permission the ROUTE'S OWN CONTRACT declares — the same field OpenAPI publishes
 * and the shell's auth hook enforces, so a handler cannot drift from its contract. Belt and
 * braces on top of the hook: a bare test app that forgets to install it still cannot serve an
 * unscoped request.
 */
function requireScope(auth: RequestAuth, descriptor: RouteDescriptor): void {
  const scope = descriptor.permission;
  if (scope === null) return;
  if (!auth.scopes.includes(scope)) throw new ForbiddenError(`Missing required scope: ${scope}`);
}

/**
 * `orc_runs.requested_by` is NOT NULL: a run is always attributable to a person. A service
 * token has no user behind it, so it is refused here with a sentence that says why, rather than
 * reaching Postgres and coming back as a 500 on a foreign key.
 */
function requireUser(auth: RequestAuth): string {
  if (auth.userId === null || auth.userId.length === 0) {
    throw new ForbiddenError(
      "Triggering a run requires a user credential: a run is attributed to the person who asked for it",
    );
  }
  return auth.userId;
}

/**
 * `Retry-After` on a spent daily budget. A day's quota resets at UTC midnight, but telling a CI
 * job to come back in up to 24h is useless — a minute is the smallest honest answer that does
 * not turn a 429 into a hot loop.
 */
const QUOTA_RETRY_AFTER_SECONDS = 60;

export interface OrchestrationRoutesDeps {
  /**
   * The two loaders phase 0 needs. elements and testdata sit before authoring in the DAG but
   * have no facade until M4, so they stay injection ports handed in by the composition root.
   */
  readonly compile: StartRunDeps;
}

export function orchestrationRoutes(db: TkDb, deps: OrchestrationRoutesDeps): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    // Enforce the descriptors' zod schemas inside this plugin's own encapsulated context (same
    // reason as authoring: a declared schema that is never compiled validates nothing).
    app.setValidatorCompiler(validatorCompiler);

    const route = (
      descriptor: RouteDescriptor,
      handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    ): void => {
      app.route({
        method: descriptor.method.toUpperCase() as MethodUpper,
        url: toFastifyPath(descriptor.path),
        config: { tk: descriptor },
        schema: {
          ...(descriptor.params !== undefined ? { params: descriptor.params } : {}),
          ...(descriptor.query !== undefined ? { querystring: descriptor.query } : {}),
          ...(descriptor.body !== undefined ? { body: descriptor.body } : {}),
        },
        handler,
      });
    };

    const tenantOf = (auth: RequestAuth): TenantContext => ({ teamId: auth.teamId });
    const runIdOf = (request: FastifyRequest): string => (request.params as { runId: string }).runId;

    route(triggerRunDescriptor, async (request, reply) => {
      const auth = authOf(request);
      requireScope(auth, triggerRunDescriptor);
      const requestedBy = requireUser(auth);
      const body = triggerRunBodySchema.parse(request.body);
      const ctx = tenantOf(auth);
      const result = await withTenant(db, ctx, (tx) =>
        startRun(
          tx,
          ctx,
          {
            projectId: body.projectId,
            targetCaseIds: body.caseIds,
            lane: body.lane,
            pin: body.pin,
            requestedBy,
            now: new Date(),
            ...(body.screenshots === undefined ? {} : { screenshots: body.screenshots }),
          },
          deps.compile,
        ),
      );

      switch (result.kind) {
        case "queued":
          return reply.code(202).send({
            runId: result.runId,
            status: "queued",
            planContentHash: result.planHash,
            chainTotal: result.chainCount,
          });
        case "compile_error":
          // 200, not 4xx: the request was fine and the product has an answer for it. The whole
          // transaction already rolled the quota back — no browser was ever going to start.
          return reply.code(200).send({
            runId: result.runId,
            status: "finished",
            verdict: "compile_error",
            diagnostics: result.diagnostics,
          });
        case "rejected_quota":
          throw new TooManyRequestsError(
            `Daily run budget spent: ${String(result.used)} of ${String(result.limit)}`,
            QUOTA_RETRY_AFTER_SECONDS,
          );
      }
    });

    route(getRunDescriptor, async (request, reply) => {
      const auth = authOf(request);
      requireScope(auth, getRunDescriptor);
      const ctx = tenantOf(auth);
      const runId = runIdOf(request);
      const run = await withTenant(db, ctx, (tx) => loadRunStatus(tx, ctx, runId));
      if (run === undefined) throw new NotFoundError(`Run not found: ${runId}`);
      return reply.code(200).send(run);
    });

    route(abortRunDescriptor, async (request, reply) => {
      const auth = authOf(request);
      requireScope(auth, abortRunDescriptor);
      const ctx = tenantOf(auth);
      const runId = runIdOf(request);
      const outcome = await withTenant(db, ctx, (tx) =>
        abortRun(tx, ctx, { runId, now: new Date() }),
      );
      if (outcome === undefined) throw new NotFoundError(`Run not found: ${runId}`);
      return reply.code(200).send({
        runId,
        verdict: "cancelled",
        cancelledJobs: outcome.cancelledJobs,
      });
    });

    route(streamRunDescriptor, async (request, reply) => {
      const auth = authOf(request);
      requireScope(auth, streamRunDescriptor);
      const ctx = tenantOf(auth);
      const runId = runIdOf(request);
      // Visibility is checked BEFORE the hijack: once the reply is hijacked there is no way
      // left to send a 404 body, only to close a socket the client would read as a network
      // failure. This is also what keeps another team's run a 404 rather than an empty stream.
      const run = await withTenant(db, ctx, (tx) => loadRunStatus(tx, ctx, runId));
      if (run === undefined) throw new NotFoundError(`Run not found: ${runId}`);
      streamRun(request, reply, ctx, runId, { db });
      return reply;
    });
  };
}
