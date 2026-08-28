/**
 * Hook onRequest: một chỗ duy nhất biến `Authorization: Bearer …` thành RequestContext.
 *
 * Ba luật không thương lượng ở đây:
 *  1. teamId đến từ credential, không bao giờ từ client.
 *  2. Không có credential hợp lệ ⇒ 401. Có, nhưng thiếu quyền TRONG team mình ⇒ 403.
 *     Tài nguyên của team khác ⇒ 404 — nhưng đó là việc của handler + RLS, không phải hook.
 *  3. Action HIGH (isHighRisk) bỏ qua cache: `fresh: true`.
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
    // Route không tồn tại: Fastify để `config` là undefined (spike 2026-08-28) —
    // kiểu của Fastify không nói điều đó, nên đọc qua biến có `| undefined`.
    const config: FastifyContextConfig | undefined = req.routeOptions.config;
    const descriptor = config?.tk;
    // Route không khai descriptor (healthz, 404 router) ⇒ không có gì để bảo vệ.
    if (descriptor === undefined || descriptor.auth === "public") return;

    const header = req.headers.authorization ?? "";
    const m = BEARER.exec(header);
    if (m === null || m[1] === undefined) throw new UnauthorizedError("thiếu hoặc sai Authorization");

    const fresh = descriptor.permission !== null && isHighRisk(descriptor.permission);
    const principal = await deps.authenticator.authenticate(m[1], { fresh });
    if (principal === null) throw new UnauthorizedError("credential không hợp lệ");

    authorize(principal.role, principal.scopes, descriptor.permission);
    req.tk = principal;
  });
}
