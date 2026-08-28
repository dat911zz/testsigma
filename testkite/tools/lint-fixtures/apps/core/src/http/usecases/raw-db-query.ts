/**
 * DELIBERATE VIOLATION, shell layer: `apps/core/src/http` is where the raw handle is first
 * threaded in, so it is exactly where a tenant-less transaction would slip in unnoticed. The
 * shell passes `db` INTO `withTenant()`; it never queries it.
 */
import type { TkDb } from "../../modules/kernel/index.js";

export async function onboard(deps: { readonly db: TkDb }): Promise<unknown> {
  return deps.db.transaction(async (tx) => tx.insert());
}
