/**
 * The compiler needs base_url + vars + the NAMES of the available secrets (never a value).
 * planning sits AFTER authoring and BEFORE orchestration in the DAG, so orchestration
 * calling this is a forward call; authoring receiving the result as a parameter is why
 * buildCompileSnapshot takes `env` instead of importing planning.
 */
import { sql } from "drizzle-orm";
import { NotFoundError, type EnvDto } from "@testkite/contract";
import { assertTenantContext, firstRow, type TenantContext, type TkTx } from "../kernel/index.js";

/** Extends NotFoundError so the shared HTTP error handler maps it to 404, never 403. */
export class EnvironmentNotFoundError extends NotFoundError {
  constructor(projectId: string) {
    super(`No environment for project ${projectId}`);
    this.name = "EnvironmentNotFoundError";
  }
}

export async function loadRunEnvironment(
  tx: TkTx,
  ctx: TenantContext,
  projectId: string,
): Promise<EnvDto> {
  const teamId = assertTenantContext(ctx);
  // RLS already scoped this to the tenant, so "not visible" and "not there" are the same
  // answer on purpose — the caller turns both into 404 (blueprint §3 L3). `team_id` is
  // still named in the predicate: layer L1 never leans on RLS alone.
  const row = firstRow(
    await tx.execute(sql`
      SELECT base_url FROM pln_environments
       WHERE team_id = ${teamId} AND project_id = ${projectId} AND status <> 'archived'
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name
       LIMIT 1`),
  );
  if (row === undefined) throw new EnvironmentNotFoundError(projectId);
  // M4 adds vars + secret_refs; until then a run has no env vars and no secrets, and the
  // compiler's `secret_ref_unknown` diagnostic is what tells the author so.
  return { baseUrl: String(row["base_url"]), vars: {}, secretNames: [] };
}
