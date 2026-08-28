/**
 * The governance part of onboarding: default quota limits. Runs inside onboarding's
 * TRANSACTION (takes a `TkTx`, not a `TkDb`) — either all of it commits, or none of it.
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { quotaLimits } from "./db/schema.js";

/** Idempotent: calling it again doesn't change limits an operator has already hand-tuned. */
export async function seedQuotaDefaults(tx: TkTx, ctx: TenantContext): Promise<void> {
  const teamId = assertTenantContext(ctx);
  await tx.insert(quotaLimits).values({ teamId }).onConflictDoNothing({ target: quotaLimits.teamId });
}
