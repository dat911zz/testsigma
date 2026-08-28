/**
 * The planning part of onboarding: 3 environment stubs. Runs inside onboarding's
 * TRANSACTION (takes a `TkTx`), so an env can never exist without its team/project.
 */
import { and, eq, inArray } from "drizzle-orm";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { plnEnvironments } from "./db/schema.js";

export const ONBOARD_ENV_NAMES = ["dev", "staging", "prod"] as const;

/** 3 env stubs, using the team's real base_url; idempotent on (team, project, name). */
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
  // Idempotent re-run: nothing new is INSERTed, but the caller still needs the ids of
  // the 3 existing envs. RLS pins this read to the team — and to NOTHING ELSE, so the
  // filter has to name the other two thirds of the key itself: a team with a second
  // project would otherwise be handed that project's environments as well.
  const existing = await tx
    .select({ id: plnEnvironments.id })
    .from(plnEnvironments)
    .where(
      and(
        eq(plnEnvironments.teamId, teamId),
        eq(plnEnvironments.projectId, input.projectId),
        inArray(plnEnvironments.name, [...ONBOARD_ENV_NAMES]),
      ),
    );
  return existing.map((r) => r.id);
}
