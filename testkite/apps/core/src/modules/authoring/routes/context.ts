/**
 * The ONLY place that touches the shape of the identity module.
 *
 * The identity middleware decorates each authenticated request with `request.tk`
 * (a RequestContext). If identity ever renames or reshapes that, fix THIS FILE only —
 * nothing in the services reads it. That is the entire reason this file exists.
 *
 * We read `request.tk` structurally (via a cast) instead of importing the Fastify
 * augmentation from the HTTP shell, so the authoring module stays off the shell's
 * import graph (DAG: modules never import the shell).
 */
import type { FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "@testkite/contract";

export interface RequestAuth {
  readonly teamId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
}

/** What the identity middleware puts on `request.tk`; `userId` is null for service tokens. */
interface DecoratedContext {
  readonly teamId: string;
  readonly userId: string | null;
  readonly scopes: readonly string[];
}

/**
 * The slice of a contract route descriptor this module needs. Structural on purpose: a
 * `RouteDescriptor` from @testkite/contract satisfies it without this file having to know
 * anything else about the contract, and — more to the point — a bare scope string does not,
 * so the compiler is what stops a hand-typed permission from creeping back in.
 */
export interface ScopedDescriptor {
  /** `null` = the route needs authentication only; there is no scope to check. */
  readonly permission: string | null;
}

/**
 * 403 — the credential lacks a scope this route requires. Extends the contract's
 * ForbiddenError so the shared handler maps it to 403 (not 500), and it reads the same
 * as any other same-tenant permission failure (code FORBIDDEN) — consistent with the
 * identity auth hook's own authorize(). Cross-tenant access is 404, handled elsewhere.
 */
export class InsufficientScopeError extends ForbiddenError {
  constructor(scope: string) {
    super(`Missing required scope: ${scope}`);
    this.name = "InsufficientScopeError";
  }
}

export function getAuth(request: FastifyRequest): RequestAuth {
  const ctx = (request as unknown as { tk?: DecoratedContext | null }).tk;
  // `scopes` is checked here for the same reason `teamId` is: this cast is the only
  // contact point with identity's shape, so it is the only place that can notice the
  // shape has drifted. Without the Array check a non-array value flows into
  // `scopes.includes(...)` below, where `undefined` becomes a TypeError served as 500
  // instead of an auth failure, and a plain STRING quietly answers true for any scope
  // name it happens to contain — a substring match reading as a granted permission.
  if (
    ctx === undefined ||
    ctx === null ||
    ctx.teamId.length === 0 ||
    !Array.isArray(ctx.scopes)
  ) {
    // Cannot happen once the identity middleware has run — fail loud rather than
    // quietly serving a request with no tenant (L1 fail-closed).
    throw new UnauthorizedError(
      "request.tk is absent or malformed: the identity middleware must run before the authoring routes",
    );
  }
  if (ctx.userId === null || ctx.userId.length === 0) {
    // Authoring writes stamp a human author (four-eyes needs a real identity); a
    // service token has no user to attribute, so it cannot author cases.
    throw new ForbiddenError("Authoring requires a user credential; service tokens cannot author cases");
  }
  return { teamId: ctx.teamId, userId: ctx.userId, scopes: ctx.scopes };
}

/**
 * Enforces the permission the ROUTE'S OWN CONTRACT declares. Taking the descriptor rather
 * than a scope string leaves exactly one source for "what does this route require": the
 * same field OpenAPI publishes and the shell's auth hook enforces. A handler can no longer
 * drift from its contract, because there is nothing left to keep in sync.
 */
export function requireScope(auth: RequestAuth, descriptor: ScopedDescriptor): void {
  const scope = descriptor.permission;
  // `null` = authentication only. Being logged in is the whole requirement, so there is
  // nothing to compare against — not a silent pass through a missing check.
  if (scope === null) return;
  if (!auth.scopes.includes(scope)) throw new InsufficientScopeError(scope);
}
