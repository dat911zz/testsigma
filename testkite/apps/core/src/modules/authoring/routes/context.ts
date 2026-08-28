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
  if (ctx === undefined || ctx === null || ctx.teamId.length === 0) {
    // Cannot happen once the identity middleware has run — fail loud rather than
    // quietly serving a request with no tenant (L1 fail-closed).
    throw new UnauthorizedError(
      "request.tk is absent: the identity middleware must run before the authoring routes",
    );
  }
  if (ctx.userId === null || ctx.userId.length === 0) {
    // Authoring writes stamp a human author (four-eyes needs a real identity); a
    // service token has no user to attribute, so it cannot author cases.
    throw new ForbiddenError("Authoring requires a user credential; service tokens cannot author cases");
  }
  return { teamId: ctx.teamId, userId: ctx.userId, scopes: ctx.scopes };
}

export function requireScope(auth: RequestAuth, scope: string): void {
  if (!auth.scopes.includes(scope)) throw new InsufficientScopeError(scope);
}
