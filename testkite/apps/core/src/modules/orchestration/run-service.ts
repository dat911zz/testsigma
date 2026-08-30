/**
 * Compiler pipeline, phase 0 and phase 8 (blueprint §4).
 *
 * Phase 0 = admission: reserve quota, open the run row, gather the snapshot. Phases 1-7 are
 * the PURE compiler (@testkite/run-compiler) — this file does the I/O so that function never
 * has to. Phase 8 = dispatch: one `job_runs` row per chain. Phase 9 (execution) happens on
 * the worker and reports back through /internal.
 *
 * The whole thing runs in ONE transaction — the caller's `tx`, so a route can wrap the run
 * and its audit trail together. Either a run exists with a frozen plan and its jobs, or
 * nothing happened at all. A half-created run whose jobs are missing would sit in the queue
 * forever, and a job without a plan would kill a worker on claim.
 */
import { sql } from "drizzle-orm";
import type { AuthoredCaseDto, AuthoredStepDto, CompileSnapshotDto } from "@testkite/contract";
import {
  compileRun,
  PLAN_FORMAT_VERSION,
  type AuthoredCase,
  type AuthoredStep,
  type CompileDiagnostic,
  type CompileSnapshot,
  type RunLane,
  type ScreenshotPolicy,
} from "@testkite/run-compiler";
import { assertTenantContext, firstRow, type TenantContext, type TkTx } from "../kernel/index.js";
import { buildCompileSnapshot, type SnapshotDeps, type SnapshotPin } from "../authoring/index.js";
import { refundRunSlot, reserveRunSlot } from "../governance/index.js";
import { loadRunEnvironment } from "../planning/index.js";

export const JOB_COST_MAX = 8;

/** Dispatcher cost model (blueprint §5): a 200-step chain must not count the same as a 3-step one. */
export function jobCost(stepCount: number): number {
  return Math.min(Math.max(Math.ceil(stepCount / 10), 1), JOB_COST_MAX);
}

export interface StartRunInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly lane: RunLane;
  readonly pin: SnapshotPin;
  readonly requestedBy: string;
  readonly screenshots?: ScreenshotPolicy;
  readonly now: Date;
}

/**
 * elements and testdata sit BEFORE authoring in the DAG but have no facade until M4, so the
 * two loaders stay injection ports — exactly the ones `buildCompileSnapshot` declares. `env`
 * is NOT a port: phase 0 loads it from planning itself, because authoring may not import a
 * module that comes after it.
 */
export interface StartRunDeps {
  readonly loadElements: SnapshotDeps["loadElements"];
  readonly loadDataProfiles: SnapshotDeps["loadDataProfiles"];
}

export type StartRunResult =
  | { readonly kind: "queued"; readonly runId: string; readonly planHash: string; readonly chainCount: number }
  | { readonly kind: "compile_error"; readonly runId: string; readonly diagnostics: readonly CompileDiagnostic[] }
  | { readonly kind: "rejected_quota"; readonly used: number; readonly limit: number };

export async function startRun(
  tx: TkTx,
  ctx: TenantContext,
  input: StartRunInput,
  deps: StartRunDeps,
): Promise<StartRunResult> {
  const teamId = assertTenantContext(ctx);

  // ---- phase 0a: admission. Reserve FIRST: compiling a 200-case chain for a team that has
  // no budget left is work nobody asked for.
  const quota = await reserveRunSlot(tx, ctx, { now: input.now });
  if (!quota.granted) return { kind: "rejected_quota", used: quota.used, limit: quota.limit };

  const runRow = firstRow(
    await tx.execute(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, status, requested_by, pin)
      VALUES (${teamId}, ${input.projectId}, ${input.lane}, 'compiling', ${input.requestedBy}, ${input.pin})
      RETURNING id`),
  );
  if (runRow === undefined) throw new Error("orc_runs: INSERT returned no id");
  const runId = String(runRow["id"]);

  // ---- phase 0b: snapshot. A case from another team simply is not visible under RLS, so
  // buildCompileSnapshot raises CaseNotFoundError => 404, never 403. Throwing here rolls the
  // whole transaction back, quota reservation included.
  const env = await loadRunEnvironment(tx, ctx, input.projectId);
  const snapshot = await buildCompileSnapshot(
    tx,
    ctx,
    { projectId: input.projectId, targetCaseIds: input.targetCaseIds, pin: input.pin },
    { loadElements: deps.loadElements, loadDataProfiles: deps.loadDataProfiles, env },
  );

  // ---- phases 1-7: PURE. No I/O, no clock, no randomness — same input, same content hash.
  const compiled = compileRun({
    snapshot: toCompileSnapshot(snapshot),
    lane: input.lane,
    ...(input.screenshots === undefined ? {} : { screenshots: input.screenshots }),
  });

  if (compiled.plan === undefined) {
    for (const d of compiled.diagnostics) {
      await tx.execute(sql`
        INSERT INTO orc_compile_diagnostics (team_id, run_id, severity, code, case_id, step_ordinal, message)
        VALUES (${teamId}, ${runId}, ${d.severity}, ${d.code}, ${d.caseId}, ${d.stepOrdinal ?? null}, ${d.message})`);
    }
    await tx.execute(sql`
      UPDATE orc_runs
         SET status = 'finished', verdict = 'compile_error', finished_at = ${input.now.toISOString()}::timestamptz
       WHERE team_id = ${teamId} AND id = ${runId}`);
    // The run never touched the fleet, so the day's budget goes back (blueprint §4).
    await refundRunSlot(tx, ctx, { now: input.now });
    return { kind: "compile_error", runId, diagnostics: compiled.diagnostics };
  }

  const plan = compiled.plan;
  await tx.execute(sql`
    INSERT INTO orc_run_plans (team_id, run_id, content_hash, plan_format_version, plan)
    VALUES (${teamId}, ${runId}, ${plan.contentHash}, ${PLAN_FORMAT_VERSION}, ${JSON.stringify(plan)}::jsonb)`);

  // ---- phase 8: dispatch. One row per chain — the chain is the unit of isolation
  // (1 browser context, 1 lease, 1 verdict). Deviation from the plan's draft, which called
  // the compiler's `countSteps(chain)` here: phase 6 already stamped `stepCount` on every
  // chain for exactly this reader ("the dispatcher computes cost from this, no re-walking
  // the tree"), so counting again would be a second, drift-prone source of the same number.
  for (const chain of plan.chains) {
    await tx.execute(sql`
      INSERT INTO job_runs (team_id, run_id, chain_key, lane, job_kind, status, cost)
      VALUES (${teamId}, ${runId}, ${chain.chainKey}, ${input.lane}, 'chain', 'pending', ${jobCost(chain.stepCount)})`);
  }

  await tx.execute(sql`
    UPDATE orc_runs
       SET status = 'queued', plan_hash = ${plan.contentHash},
           chain_total = ${plan.chains.length}, started_at = ${input.now.toISOString()}::timestamptz
     WHERE team_id = ${teamId} AND id = ${runId}`);

  return { kind: "queued", runId, planHash: plan.contentHash, chainCount: plan.chains.length };
}

/**
 * `CompileSnapshotDto` (contract) and `CompileSnapshot` (compiler) describe the same data,
 * but the contract writes every optional as `?: T | undefined` — the shape zod infers — while
 * the compiler writes `?: T`. Under `exactOptionalPropertyTypes` those are NOT assignable, so
 * the boundary needs a real adapter and orchestration is where the two meet.
 *
 * Deliberately a rebuild, not a cast: a cast would be a promise that the two shapes can never
 * drift, and `contract-conformance.test.ts` exists precisely because they can. Spreading each
 * optional in only when it holds a value is also what keeps an explicit `undefined` out of the
 * plan — the compiler hashes an absent field and an `undefined` one identically, but only
 * because `canonicalJson` drops it; nothing downstream should have to rely on that.
 */
function toCompileSnapshot(dto: CompileSnapshotDto): CompileSnapshot {
  const cases: Record<string, AuthoredCase> = {};
  for (const [id, authored] of Object.entries(dto.cases)) cases[id] = toAuthoredCase(authored);
  return {
    teamId: dto.teamId,
    projectId: dto.projectId,
    targetCaseIds: dto.targetCaseIds,
    cases,
    // Elements, data profiles and env carry no optional field, so they cross as they are.
    elements: dto.elements,
    dataProfiles: dto.dataProfiles,
    env: dto.env,
  };
}

function toAuthoredCase(dto: AuthoredCaseDto): AuthoredCase {
  return {
    id: dto.id,
    revisionId: dto.revisionId,
    name: dto.name,
    isStepGroup: dto.isStepGroup,
    ...(dto.prereqCaseId === undefined ? {} : { prereqCaseId: dto.prereqCaseId }),
    ...(dto.dataProfileId === undefined ? {} : { dataProfileId: dto.dataProfileId }),
    steps: dto.steps.map((step) => toAuthoredStep(step)),
  };
}

function toAuthoredStep(dto: AuthoredStepDto): AuthoredStep {
  const common = { ordinal: dto.ordinal, renderedSentence: dto.renderedSentence };
  switch (dto.kind) {
    case "action":
      return {
        ...common,
        kind: "action",
        verbOpKey: dto.verbOpKey,
        ...(dto.args === undefined ? {} : { args: dto.args }),
        ...(dto.elementId === undefined ? {} : { elementId: dto.elementId }),
      };
    case "step_group":
      return { ...common, kind: "step_group", stepGroupCaseId: dto.stepGroupCaseId };
    case "if":
      return {
        ...common,
        kind: "if",
        conditionExpected: dto.conditionExpected,
        children: dto.children.map((child) => toAuthoredStep(child)),
      };
    case "for":
      return {
        ...common,
        kind: "for",
        loopDataProfileId: dto.loopDataProfileId,
        children: dto.children.map((child) => toAuthoredStep(child)),
      };
    case "while":
      return {
        ...common,
        kind: "while",
        children: dto.children.map((child) => toAuthoredStep(child)),
        ...(dto.maxIterations === undefined ? {} : { maxIterations: dto.maxIterations }),
      };
    case "rest":
      return { ...common, kind: "rest", ...(dto.args === undefined ? {} : { args: dto.args }) };
  }
}
