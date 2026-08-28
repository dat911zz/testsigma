/**
 * VALID: nothing queries the raw handle. `withTenant()` receives it and hands back a `TkTx`
 * that already has the app role and `app.team_id` set; `TenantRepo` only ever exposes
 * `this.tx`. Passing `deps.db` as an ARGUMENT is the sanctioned shape and must stay clean.
 */
import { TenantRepo, withTenant, type TenantContext, type TkDb, type TkTx } from "../kernel/index.js";

type Deps = { readonly db: TkDb };

class CaseRepo extends TenantRepo {
  list(): unknown {
    return this.tx.select();
  }
}

export async function listCases(deps: Deps, ctx: TenantContext): Promise<unknown> {
  return withTenant(deps.db, ctx, async (tx: TkTx) => {
    await tx.execute("SELECT 1");
    return new CaseRepo(tx, ctx).list();
  });
}
