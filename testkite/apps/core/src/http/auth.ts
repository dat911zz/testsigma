/**
 * onRequest hook: the one place that turns `Authorization: Bearer …` into a RequestContext.
 *
 * Three non-negotiable rules here:
 *  1. teamId comes from the credential, never from the client.
 *  2. No valid credential ⇒ 401. Valid, but missing a permission WITHIN one's own team ⇒ 403.
 *     A resource from another team ⇒ 404 — but that's the handler + RLS's job, not the hook's.
 *  3. HIGH actions (isHighRisk) bypass the cache: `fresh: true`.
 */
import type { FastifyContextConfig } from "fastify";
import { UnauthorizedError } from "@testkite/contract";
import { authorize, isHighRisk } from "../modules/identity/index.js";
import type { Authenticator } from "../modules/identity/index.js";
import type { TkApp } from "./app.js";

const BEARER = /^Bearer (.+)$/;

export function installAuth(app: TkApp, deps: { readonly authenticator: Authenticator }): void {
  app.decorateRequest("tk", null);

  app.addHook("onRequest", async (req) => {
    // A route that doesn't exist: Fastify leaves `config` undefined (spike 2026-08-28) —
    // Fastify's types don't say so, so it's read through a variable typed `| undefined`.
    const config: FastifyContextConfig | undefined = req.routeOptions.config;
    const descriptor = config?.tk;
    // A route with no descriptor declared (healthz, the 404 router) ⇒ nothing to guard.
    if (descriptor === undefined || descriptor.auth === "public") return;

    const header = req.headers.authorization ?? "";
    const m = BEARER.exec(header);
    if (m === null || m[1] === undefined) throw new UnauthorizedError("missing or malformed Authorization");

    const fresh = descriptor.permission !== null && isHighRisk(descriptor.permission);
    const principal = await deps.authenticator.authenticate(m[1], { fresh });
    if (principal === null) throw new UnauthorizedError("invalid credential");

    authorize(principal.role, principal.scopes, descriptor.permission);
    req.tk = principal;
  });
}
