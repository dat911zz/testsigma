/**
 * The orchestration part of onboarding: an egress policy in OBSERVE mode.
 * Runs inside onboarding's TRANSACTION (takes a `TkTx`).
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { egressPolicies } from "./db/schema.js";

export const EGRESS_OBSERVE_DAYS = 14;

/**
 * Seeds the allowlist from the team's own base_url, 14-day observe mode (blueprint S8).
 * Idempotent thanks to `unique(team_id)` — see the deviation-from-plan note in db/schema.ts.
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
