/**
 * `/internal/fleet` — a SEPARATE Fastify instance on its own port (INTERNAL_PORT, bound to
 * INTERNAL_HOST, which defaults to 127.0.0.1). Not a prefix on the public app, because the two
 * have nothing in common: different credentials, a different error taxonomy, and the public app
 * is the one that faces the internet. A network policy can simply not expose this port.
 *
 * WHY THE SHELL TIER, not `modules/orchestration/internal/` as the plan's file table listed it:
 * these seven handlers compose orchestration (the queue, the two token kinds) WITH results
 * (case rows, artifact slots), and `results` sits AFTER `orchestration` in module-dag.json. An
 * orchestration file importing the results facade is a backward edge — eslint-boundaries refuses
 * it, and rightly: the DAG is what keeps `res_*` owned by one module. The shell is the tier that
 * exists precisely to wire two modules together through their facades (same reason
 * `http/usecases/onboard-team.ts` lives here rather than inside identity), so the plane is built
 * here and everything below it is reached through `modules/<name>/index.js`.
 *
 * The auth hook reads `config.tkInternal` exactly like `installAuth` reads `config.tk` for /v1
 * (M2 pattern), so a route registered without a descriptor is a route with NO credential check —
 * and `internal-coverage.test.ts` is what makes that impossible to ship unnoticed.
 */
import Fastify, { type FastifyContextConfig, type FastifyInstance } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { NotFoundError, UnauthorizedError } from "@testkite/contract";
import type { KernelEnv, TkDb } from "../../modules/kernel/index.js";
import {
  jobExistsForTeam,
  verifyRunToken,
  verifyWorkerToken,
} from "../../modules/orchestration/index.js";
import { installErrorHandler } from "../errors.js";
import { LOG_SERIALIZERS } from "../log-serializers.js";
import { internalRoutes } from "./routes.js";

const BEARER = /^Bearer (.+)$/;
/** Path params are still raw strings in `onRequest`: the route's zod schema runs later. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InternalAppDeps {
  readonly env: KernelEnv;
  readonly db: TkDb;
  /** SHA-256 of `FLEET_BOOTSTRAP_TOKEN`. Hashed at the composition root; never held in clear here. */
  readonly bootstrapTokenHash: Buffer;
  /**
   * The claim budget's clock, and ONLY that budget's — see `internalRoutes`. Omitted in
   * production, where it is `Date.now`; supplied by a suite that needs the refill to happen at
   * instants it names instead of at whatever the host's load made of them.
   */
  readonly claimClock?: () => number;
}

export async function buildInternalApp(deps: InternalAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Same redaction as the public plane — this one talks to the fleet, but it runs the same
    // error handler over the same database driver. See log-serializers.ts.
    logger: { level: deps.env.LOG_LEVEL, serializers: LOG_SERIALIZERS },
    genReqId: () => randomUUID(),
    // A complete() payload carries every step of a chain; 1MB is not enough, 8MB is.
    bodyLimit: 8 * 1_048_576,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);
  app.decorateRequest("tkRun", null);
  app.decorateRequest("tkWorker", null);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.addHook("onRequest", async (req) => {
    // A route that does not exist: Fastify leaves `config` undefined (spike 2026-08-28) — its
    // types do not say so, so it is read through a variable typed `| undefined`.
    const config: FastifyContextConfig | undefined = req.routeOptions.config;
    const descriptor = config?.tkInternal;
    // No descriptor = /healthz and the 404 router. Nothing to guard, nothing to hand a scope to.
    if (descriptor === undefined) return;
    const m = BEARER.exec(req.headers.authorization ?? "");
    if (m === null || m[1] === undefined) {
      throw new UnauthorizedError("missing or malformed Authorization");
    }
    const presented = m[1];

    if (descriptor.credential === "bootstrap") {
      const hash = createHash("sha256").update(presented).digest();
      // Constant-time compare: the bootstrap token is long-lived and shared per host, so a
      // timing oracle on it is worth closing. The length guard comes first because
      // timingSafeEqual throws on a length mismatch — and both operands are digests here, so
      // it can only ever fire on a misconfigured hash, never on attacker-chosen input.
      if (
        hash.length !== deps.bootstrapTokenHash.length ||
        !timingSafeEqual(hash, deps.bootstrapTokenHash)
      ) {
        throw new UnauthorizedError("invalid bootstrap credential");
      }
      return;
    }

    if (descriptor.credential === "worker") {
      const scope = await verifyWorkerToken(deps.db, presented, new Date());
      if (scope === null) throw new UnauthorizedError("invalid worker credential");
      // A worker token names ONE worker; using it on another worker's path is a 401, not a 404
      // (a 404 would confirm whether that worker exists — and `orc_workers` is fleet-wide, with
      // no tenant to hide behind).
      const wanted = (req.params as { workerId?: string }).workerId;
      if (wanted !== undefined && wanted !== scope.workerId) {
        throw new UnauthorizedError("worker scope mismatch");
      }
      req.tkWorker = scope;
      return;
    }

    const scope = await verifyRunToken(deps.db, presented, new Date());
    if (scope === null) throw new UnauthorizedError("invalid run credential");
    const wanted = (req.params as { jobRunId?: string }).jobRunId;
    if (wanted !== undefined && wanted !== scope.jobRunId) {
      /*
       * The token names one job and the request names another. Two very different situations
       * hide behind that, and the worker reacts to them differently (401 = exit and re-register,
       * 404 = drop this job and carry on), so they are told apart HERE — by asking whether the
       * requested job is visible TO THE TOKEN'S OWN TENANT:
       *   - not visible (another team's job, or no job at all) => 404. The two cases answer
       *     identically on purpose: any other answer would confirm that another team's id
       *     exists, and cross-tenant is 404, never 403 (blueprint §3 L3).
       *   - visible => the id is this tenant's own, so nothing is leaked by saying that this
       *     particular credential does not cover it: 401.
       * A malformed id cannot name any job, so it takes the 404 branch without a round trip —
       * the route's zod schema would have said the same thing, but it only runs later.
       */
      const visible =
        UUID.test(wanted) && (await jobExistsForTeam(deps.db, { teamId: scope.teamId, jobRunId: wanted }));
      if (!visible) throw new NotFoundError("Job run not found.");
      throw new UnauthorizedError("run scope mismatch");
    }
    req.tkRun = scope;
  });

  // `exactOptionalPropertyTypes`: an absent clock and one explicitly set to `undefined` are not
  // the same type, so the key is spread in only when there is one.
  await app.register(
    internalRoutes({
      db: deps.db,
      env: deps.env,
      ...(deps.claimClock === undefined ? {} : { claimClock: deps.claimClock }),
    }),
  );
  return app;
}
