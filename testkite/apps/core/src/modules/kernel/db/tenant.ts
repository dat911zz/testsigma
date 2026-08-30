import { sql } from "drizzle-orm";
// Module boundary: kernel is the ROOT of the DAG (module-dag.json) — it may not import
// any other module, identity included. That's why APP_ROLE lives in kernel itself, next to
// RELAY_ROLE (guarded by: eslint-boundaries + test/arch/module-boundaries.test.ts).
import { APP_ROLE, AUTH_ROLE, DISPATCH_ROLE } from "./schema.js";
import { assertTenantContext } from "./repo.js";
import type { TenantContext, TkDb, TkTx } from "./types.js";

/**
 * Open a transaction bound to a tenant. Two things, in this order:
 *   1. SET LOCAL ROLE testkite_app — RLS only takes effect for a non-superuser,
 *      non-owner role (spike 2026-08-27: superuser bypasses RLS even with FORCE).
 *   2. set_config('app.team_id', $1, true) — is_local=true so it auto-reverts when the tx closes;
 *      pass it as a PARAMETER, never interpolate a string into the SQL.
 */
export async function withTenant<T>(
  db: TkDb,
  ctx: TenantContext,
  fn: (tx: TkTx) => Promise<T>,
): Promise<T> {
  const teamId = assertTenantContext(ctx);
  return db.transaction(async (tx) => {
    // APP_ROLE is our own compile-time constant, not user input.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.team_id', ${teamId}, true)`);
    return fn(tx);
  });
}

/**
 * Transaction for the AUTHENTICATION PATH: `SET LOCAL ROLE testkite_auth` and does NOT set
 * `app.team_id` — because at this point we don't know the tenant yet; that's precisely what we're looking up.
 *
 * This role can only SELECT api_tokens/memberships/users (migration 0016). Once
 * teamId is known, the rest of the request runs through withTenant() as usual.
 */
export async function withAuthRole<T>(db: TkDb, fn: (tx: TkTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // AUTH_ROLE is our own compile-time constant, not user input.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${AUTH_ROLE}`));
    return fn(tx);
  });
}

/**
 * Transaction for the DISPATCH PATH: `SET LOCAL ROLE testkite_dispatch`, and deliberately
 * does NOT set `app.team_id` — the tenant is the ANSWER of the claim query, not its input.
 * Everything after the claim (writing results, minting a run token) runs through withTenant()
 * with the team_id the claim just returned.
 */
export async function withDispatchRole<T>(db: TkDb, fn: (tx: TkTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // DISPATCH_ROLE is our own compile-time constant, not user input.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${DISPATCH_ROLE}`));
    return fn(tx);
  });
}
