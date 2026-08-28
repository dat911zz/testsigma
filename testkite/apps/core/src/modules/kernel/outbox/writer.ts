import { assertTenantContext } from "../db/repo.js";
import { krnOutbox } from "../db/schema.js";
import type { TenantContext, TkTx } from "../db/types.js";

export type OutboxEvent = {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
};

/**
 * Write a domain event to the outbox. Accepts ONLY TkTx (never TkDb): the type forces the
 * caller to already be inside a transaction, so an event can never exist without its
 * accompanying domain write — and vice versa. No side-effect exists outside the transaction.
 *
 * Deliberate deviation from the block in the plan: uses the query builder instead of
 * `tx.execute(sql`INSERT ... RETURNING id`)`. Reason: `TkTx` is a driver-agnostic type
 * (`PgQueryResultHKT` isn't bound to a driver yet), so `execute()` returns `unknown` — reading `.rows`
 * would require a cast, and TestKite's TS strict mode bans casts without justification. `.returning()` gives
 * the real type `{ id: bigint }[]`; the generated SQL is still INSERT ... RETURNING "id".
 */
export async function enqueueOutbox(
  tx: TkTx,
  ctx: TenantContext,
  event: OutboxEvent,
): Promise<bigint> {
  const teamId = assertTenantContext(ctx);
  if (event.topic.trim().length === 0) {
    throw new Error("outbox: topic must not be empty");
  }
  const rows = await tx
    .insert(krnOutbox)
    .values({ teamId, topic: event.topic, payload: event.payload })
    .returning({ id: krnOutbox.id });
  const row = rows[0];
  if (row === undefined) throw new Error("outbox: INSERT did not return an id");
  return row.id;
}
