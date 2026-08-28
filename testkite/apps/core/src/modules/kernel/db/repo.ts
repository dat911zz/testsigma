import type { TenantContext, TkTx } from "./types.js";

export class MissingTenantContextError extends Error {
  constructor(reason: string) {
    super(`Invalid TenantContext: ${reason} — repository fail-closed (blueprint §3 L1)`);
    this.name = "MissingTenantContextError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws if ctx's teamId isn't a uuid. Call BEFORE anything touches the DB. */
export function assertTenantContext(ctx: TenantContext): string {
  if (ctx.teamId.length === 0) throw new MissingTenantContextError("teamId is empty");
  if (!UUID_RE.test(ctx.teamId))
    throw new MissingTenantContextError(`teamId is not a uuid: ${ctx.teamId}`);
  return ctx.teamId;
}

/**
 * Isolation layer L1: every repository extends from here, so a repo that doesn't
 * know which tenant it's serving CANNOT exist.
 */
export abstract class TenantRepo {
  readonly #tx: TkTx;
  readonly #teamId: string;

  constructor(tx: TkTx, ctx: TenantContext) {
    this.#teamId = assertTenantContext(ctx);
    this.#tx = tx;
  }

  protected get tx(): TkTx {
    return this.#tx;
  }
  protected get teamId(): string {
    return this.#teamId;
  }
}
