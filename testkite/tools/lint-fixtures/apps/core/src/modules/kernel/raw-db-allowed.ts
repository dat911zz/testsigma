/**
 * VALID: kernel is where `withTenant()` lives, so opening a transaction on a raw handle and
 * running the role/`app.team_id` setup on it is exactly its job. The rule ignores kernel.
 */
import type { TkDb } from "./index.js";

export async function open(db: TkDb): Promise<unknown> {
  return db.transaction(async (tx) => {
    await tx.execute("SELECT set_config('app.team_id', '', true)");
    return tx;
  });
}
