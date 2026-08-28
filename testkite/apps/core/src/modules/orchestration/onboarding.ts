/**
 * Phần orchestration của onboarding: chính sách egress ở chế độ OBSERVE.
 * Chạy trong TRANSACTION của onboarding (nhận `TkTx`).
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { egressPolicies } from "./db/schema.js";

export const EGRESS_OBSERVE_DAYS = 14;

/**
 * Seed allowlist từ chính base_url của team, chế độ observe 14 ngày (blueprint S8).
 * Idempotent nhờ `unique(team_id)` — xem ghi chú lệch-plan ở db/schema.ts.
 */
export async function seedEgressObserve(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly baseUrl: string; readonly now: Date },
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  const host = new URL(input.baseUrl).hostname;
  await tx
    .insert(egressPolicies)
    .values({
      teamId,
      mode: "observe",
      allowlist: [host],
      observeUntil: new Date(input.now.getTime() + EGRESS_OBSERVE_DAYS * 86_400_000),
    })
    .onConflictDoNothing({ target: egressPolicies.teamId });
}
