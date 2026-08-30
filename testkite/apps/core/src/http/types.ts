/**
 * Types for the HTTP SHELL LAYER. Business modules import from here (one direction: the
 * shell never imports back into a module except through its facade).
 */
import type { z } from "zod";
import type { InternalRouteDescriptor, RouteDescriptor } from "@testkite/contract";
import type { CredentialKind, MembershipRole, Permission } from "../modules/identity/index.js";
import type { RunTokenScope, WorkerTokenScope } from "../modules/orchestration/index.js";

/**
 * The context of ONE request. `teamId` here is the single source of truth for the tenant —
 * it comes from the credential, NEVER from the path/query/body (Global Constraints).
 */
export type RequestContext = {
  readonly teamId: string;
  readonly userId: string | null;
  readonly tokenId: string;
  readonly authKind: CredentialKind;
  readonly role: MembershipRole;
  readonly scopes: readonly Permission[];
};

type InferOr<T, F> = T extends z.ZodTypeAny ? z.infer<T> : F;

export type RouteInput<D extends RouteDescriptor> = {
  readonly ctx: RequestContext;
  readonly params: InferOr<D["params"], Record<string, never>>;
  readonly query: InferOr<D["query"], Record<string, never>>;
  readonly body: InferOr<D["body"], undefined>;
};

/**
 * An `auth: "public"` route (login, OIDC callback) runs BEFORE any credential exists —
 * `RequestContext` doesn't exist there yet. Instead of widening `ctx` to
 * `RequestContext | null` for every handler (forcing ~50 future handlers to null-check
 * themselves, where forgetting it just ONCE means the tenant comes from somewhere other
 * than the credential), a public route's input simply has NO `ctx`. The type forces exactly
 * that: a public handler cannot read a context that doesn't exist.
 */
export type PublicRouteInput<D extends RouteDescriptor> = Omit<RouteInput<D>, "ctx">;

export type RouteRegistration =
  | {
      readonly auth: "required";
      readonly descriptor: RouteDescriptor;
      readonly handler: (input: RouteInput<RouteDescriptor>) => Promise<unknown>;
    }
  | {
      readonly auth: "public";
      readonly descriptor: RouteDescriptor;
      readonly handler: (input: PublicRouteInput<RouteDescriptor>) => Promise<unknown>;
    };

/**
 * Pairs a descriptor (the contract, in @testkite/contract) with a handler (business logic,
 * in a module). Keeps the type precise at the definition site; the registry collapses it
 * down to a RouteRegistration.
 */
export function route<D extends RouteDescriptor>(
  descriptor: D,
  handler: (input: RouteInput<D>) => Promise<unknown>,
): RouteRegistration {
  // A public descriptor + a handler that requires ctx = a permanently-401 route that was
  // supposed to be open. Catch it at app-setup time, not by a production bug.
  if (descriptor.auth === "public") {
    throw new Error(`route(): ${descriptor.operationId} is a public route — use publicRoute()`);
  }
  return { auth: "required", descriptor, handler } as RouteRegistration;
}

/** The counterpart of `route()` for `auth: "public"` descriptors. */
export function publicRoute<D extends RouteDescriptor>(
  descriptor: D,
  handler: (input: PublicRouteInput<D>) => Promise<unknown>,
): RouteRegistration {
  if (descriptor.auth !== "public") {
    throw new Error(`publicRoute(): ${descriptor.operationId} requires auth — use route()`);
  }
  return { auth: "public", descriptor, handler } as RouteRegistration;
}

declare module "fastify" {
  interface FastifyRequest {
    /** null on a public route; the auth hook sets it before every handler on a required route. */
    tk: RequestContext | null;
    /**
     * The two fleet credentials, set by the /internal/fleet auth hook (http/internal/app.ts) and
     * null everywhere else — including on every /v1 request, which never accepts either of them.
     * They live in this file, next to `tk`, because ONE file holding every Fastify augmentation
     * is what stops two of them from disagreeing about the same request object.
     */
    tkRun: RunTokenScope | null;
    tkWorker: WorkerTokenScope | null;
  }

  /**
   * The contract descriptor carried alongside a route, readable back in the `onRequest`
   * hook (`req.routeOptions.config.tk`). Fastify leaves `FastifyContextConfig` empty
   * precisely for this purpose — declaring it here means both `RouteRegistration`-style
   * routes and `FastifyPluginAsync`-style routes (plan authoring) speak the same contract, no casting.
   */
  interface FastifyContextConfig {
    readonly tk?: RouteDescriptor;
    /**
     * The same idea for the fleet plane, and a SEPARATE key on purpose: a descriptor landing in
     * `tk` would be read by the tenant auth hook, and one landing in `tkInternal` by the fleet
     * hook. Two names means a route can never be guarded by the wrong one of the two.
     */
    readonly tkInternal?: InternalRouteDescriptor;
  }

  interface FastifyInstance {
    /** Every route the router is serving + whether that route has a contract descriptor. */
    tkRegisteredRoutes: { method: string; url: string; hasDescriptor: boolean }[];
  }
}
