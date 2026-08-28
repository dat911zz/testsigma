/**
 * Phần governance của onboarding: hạn mức mặc định. Chạy trong TRANSACTION của
 * onboarding (nhận `TkTx`, không nhận `TkDb`) — hoặc tất cả, hoặc không gì.
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { quotaLimits } from "./db/schema.js";

/** Idempotent: gọi lại không đổi hạn mức đã được operator chỉnh tay. */
export async function seedQuotaDefaults(tx: TkTx, ctx: TenantContext): Promise<void> {
  const teamId = assertTenantContext(ctx);
  await tx.insert(quotaLimits).values({ teamId }).onConflictDoNothing({ target: quotaLimits.teamId });
}
