/**
 * Phần planning của onboarding: 3 environment stub. Chạy trong TRANSACTION của
 * onboarding (nhận `TkTx`) nên env không bao giờ tồn tại mà thiếu team/project.
 */
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { plnEnvironments } from "./db/schema.js";

export const ONBOARD_ENV_NAMES = ["dev", "staging", "prod"] as const;

/** 3 env stub, base_url thật của team; idempotent theo (team, project, name). */
export async function seedEnvironmentStubs(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly projectId: string; readonly baseUrl: string },
): Promise<readonly string[]> {
  const teamId = assertTenantContext(ctx);
  const rows = await tx
    .insert(plnEnvironments)
    .values(
      ONBOARD_ENV_NAMES.map((name) => ({
        teamId,
        projectId: input.projectId,
        name,
        baseUrl: input.baseUrl,
        status: "stub" as const,
      })),
    )
    .onConflictDoNothing({
      target: [plnEnvironments.teamId, plnEnvironments.projectId, plnEnvironments.name],
    })
    .returning({ id: plnEnvironments.id });
  if (rows.length > 0) return rows.map((r) => r.id);
  // Chạy lại idempotent: không INSERT thêm gì, nhưng người gọi vẫn cần id của 3 env
  // đang có. RLS đã ghim truy vấn này vào đúng team trong ctx.
  const existing = await tx.select({ id: plnEnvironments.id }).from(plnEnvironments);
  return existing.map((r) => r.id);
}
