import type { TenantContext, TkTx } from "./types.js";

export class MissingTenantContextError extends Error {
  constructor(reason: string) {
    super(`TenantContext không hợp lệ: ${reason} — repository fail-closed (blueprint §3 L1)`);
    this.name = "MissingTenantContextError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ném nếu ctx không mang teamId dạng uuid. Gọi TRƯỚC mọi thứ chạm DB. */
export function assertTenantContext(ctx: TenantContext): string {
  if (ctx.teamId.length === 0) throw new MissingTenantContextError("teamId rỗng");
  if (!UUID_RE.test(ctx.teamId))
    throw new MissingTenantContextError(`teamId không phải uuid: ${ctx.teamId}`);
  return ctx.teamId;
}

/**
 * Lớp cách ly L1: mọi repository kế thừa từ đây nên KHÔNG THỂ tồn tại
 * một repo không biết mình đang phục vụ tenant nào.
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
