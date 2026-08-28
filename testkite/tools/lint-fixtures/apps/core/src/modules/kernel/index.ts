/**
 * STUB of the kernel facade, just wide enough for the isolation-L1 fixtures to import.
 * Shapes mirror `apps/core/src/modules/kernel/db/{types,tenant,repo}.ts`; the bodies are
 * irrelevant because the lint rule under test is purely syntactic.
 */
export type TkTx = {
  select: () => unknown;
  insert: () => unknown;
  update: () => unknown;
  delete: () => unknown;
  execute: (query: string) => Promise<unknown>;
};

export type TkDb = TkTx & {
  transaction: <T>(fn: (tx: TkTx) => Promise<T>) => Promise<T>;
};

export type TenantContext = { readonly teamId: string };

/** Opens the transaction on the raw handle — kernel is the one place allowed to. */
export async function withTenant<T>(
  db: TkDb,
  _ctx: TenantContext,
  fn: (tx: TkTx) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

export abstract class TenantRepo {
  protected readonly tx: TkTx;

  constructor(tx: TkTx, _ctx: TenantContext) {
    this.tx = tx;
  }
}
