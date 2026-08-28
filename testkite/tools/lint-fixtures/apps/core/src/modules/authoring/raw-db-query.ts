/**
 * DELIBERATE VIOLATION: five queries built straight off a raw `TkDb` handle. A raw handle
 * carries no tenant — neither `SET LOCAL ROLE testkite_app` nor `app.team_id` — so RLS has
 * no predicate to apply. Isolation layer L1 requires a `TkTx` from `withTenant()` or a
 * `TenantRepo`.
 *
 * `tx.select()` on line 3 of `ownTransaction` is here on purpose: it must NOT be reported,
 * otherwise the rule would flag every legitimate query in the codebase.
 */
import type { TkDb } from "../kernel/index.js";

type Deps = { readonly db: TkDb };

/** (1) bare `db` parameter */
export function listAll(db: TkDb): unknown {
  return db.select();
}

/** (2) `deps.db` */
export function insertOne(deps: Deps): unknown {
  return deps.db.insert();
}

/** (3) a transaction opened outside `withTenant()` — tenant-less for its whole lifetime */
export async function ownTransaction(deps: Deps): Promise<unknown> {
  return deps.db.transaction(async (tx) => tx.select());
}

/** (4) `this.#db` — a raw handle stashed on a class instead of a `TkTx` */
export class Cases {
  readonly #db: TkDb;

  constructor(db: TkDb) {
    this.#db = db;
  }

  wipe(): unknown {
    return this.#db.delete();
  }
}

/** (5) a raw handle under a different name */
export async function raw(appDb: TkDb): Promise<unknown> {
  return appDb.execute("SELECT 1");
}
