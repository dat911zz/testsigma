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
import type {
  ActionStepDto,
  AuthoredCaseDto,
  AuthoredStepDto,
  CompileDiagnosticDto,
  CompileSnapshotDto,
  FieldMap,
  ForStepDto,
  IfStepDto,
  RestStepDto,
  RunChainDto,
  RunStatusDto,
  StepGroupStepDto,
  WhileStepDto,
} from "@testkite/contract";
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
import {
  assertTenantContext,
  firstRow,
  rowsOf,
  type TenantContext,
  type TkTx,
} from "../kernel/index.js";
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

  // The environment is read BEFORE the run row is opened, and that order is load-bearing:
  // `orc_runs` carries a composite FK on (team_id, project_id), so a project belonging to
  // another team used to reach Postgres and come back as a raw 500 on that constraint — a
  // cross-tenant id answering anything but 404. Under RLS an invisible project has no
  // environment either, so this read is the tenant gate as well as the compiler's input, and
  // "not yours" and "no environment configured" are deliberately the same 404.
  const env = await loadRunEnvironment(tx, ctx, input.projectId);

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

/** What a worker needs at claim time besides its own row: the project and the frozen plan. */
export interface FrozenRunPlan {
  /** `job_runs` does not carry it — the run aggregate does, and the worker's telemetry wants it. */
  readonly projectId: string;
  /** The plan exactly as phase 7 froze it. `unknown` because nothing here re-validates it. */
  readonly plan: unknown;
}

/**
 * Reads back what phase 0 froze. It lives next to the write for one reason: the pair
 * `orc_runs` + `orc_run_plans` is joined here on the same composite key the INSERT used, so a
 * change to either statement has the other one in view.
 *
 * `undefined` means the run has no frozen plan — a compile error, or a run still compiling.
 * A job in the queue for such a run is a control-plane bug, not a worker's problem, which is
 * why the answer is an absence the caller must decide about rather than an empty plan it might
 * hand to a worker.
 */
export async function readRunPlan(
  tx: TkTx,
  ctx: TenantContext,
  runId: string,
): Promise<FrozenRunPlan | undefined> {
  const teamId = assertTenantContext(ctx);
  const row = firstRow(
    await tx.execute(sql`
      SELECT r.project_id, p.plan
        FROM orc_runs r
        JOIN orc_run_plans p ON p.team_id = r.team_id AND p.run_id = r.id
       WHERE r.team_id = ${teamId} AND r.id = ${runId}`),
  );
  if (row === undefined) return undefined;
  return { projectId: String(row["project_id"]), plan: row["plan"] };
}

/**
 * Job states nothing can move away from. Kept as one list because both readers below have to
 * agree on it: `chainDone` counts them, and `abortRun` refuses to touch them.
 */
const TERMINAL_JOB_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled", "rejected_quota"];

/**
 * The same list as a SQL literal list. `sql.raw` is safe here and nowhere else: the values are
 * module constants, never input — and deriving the fragment from the array is what keeps the
 * predicate and the counter from drifting apart.
 */
const TERMINAL_JOB_STATUS_SQL = sql.raw(TERMINAL_JOB_STATUSES.map((s) => `'${s}'`).join(", "));

/** timestamptz comes back as a Date from both drivers; a driver that returns text must not lose ms. */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/**
 * The READ MODEL of a run: the aggregate, one entry per chain, and the compile diagnostics.
 * Lives next to the write for the same reason `readRunPlan` does — `startRun` is what puts
 * every one of these rows there.
 *
 * `chainDone` is COUNTED FROM THE QUEUE rather than read from `orc_runs.chain_done`: no writer
 * maintains that column yet (the roll-up lands with the results plane), and a progress number
 * that is silently always 0 is worse than one that costs a scan of a handful of rows.
 *
 * `undefined` = no such run FOR THIS TENANT. Another team's id and a nonexistent id are the
 * same answer on purpose: the caller turns both into 404, never 403 (blueprint §3 L3).
 */
export async function loadRunStatus(
  tx: TkTx,
  ctx: TenantContext,
  runId: string,
): Promise<RunStatusDto | undefined> {
  const teamId = assertTenantContext(ctx);
  const run = firstRow(
    await tx.execute(sql`
      SELECT id, project_id, lane::text AS lane, status::text AS status, verdict::text AS verdict,
             plan_hash, chain_total, started_at, finished_at
        FROM orc_runs
       WHERE team_id = ${teamId} AND id = ${runId}`),
  );
  if (run === undefined) return undefined;

  const jobRows = rowsOf(
    await tx.execute(sql`
      SELECT id, chain_key, status::text AS status, attempt, lease_epoch, started_at, finished_at
        FROM job_runs
       WHERE team_id = ${teamId} AND run_id = ${runId}
       ORDER BY queue_seq, id`),
  );
  const diagnosticRows = rowsOf(
    await tx.execute(sql`
      SELECT severity::text AS severity, code, case_id, step_ordinal, message
        FROM orc_compile_diagnostics
       WHERE team_id = ${teamId} AND run_id = ${runId}
       ORDER BY case_id, step_ordinal NULLS FIRST, code`),
  );

  const jobs: RunChainDto[] = jobRows.map((row) => ({
    jobRunId: String(row["id"]),
    chainKey: String(row["chain_key"]),
    status: String(row["status"]) as RunChainDto["status"],
    attempt: Number(row["attempt"]),
    leaseEpoch: Number(row["lease_epoch"]),
    startedAt: toIsoOrNull(row["started_at"]),
    finishedAt: toIsoOrNull(row["finished_at"]),
  }));

  return {
    runId: String(run["id"]),
    projectId: String(run["project_id"]),
    lane: String(run["lane"]) as RunStatusDto["lane"],
    status: String(run["status"]) as RunStatusDto["status"],
    verdict: String(run["verdict"]) as RunStatusDto["verdict"],
    planContentHash: run["plan_hash"] === null ? null : String(run["plan_hash"]),
    chainTotal: Number(run["chain_total"]),
    chainDone: jobs.filter((j) => TERMINAL_JOB_STATUSES.includes(j.status)).length,
    startedAt: toIsoOrNull(run["started_at"]),
    finishedAt: toIsoOrNull(run["finished_at"]),
    jobs,
    diagnostics: diagnosticRows.map((row) => ({
      severity: String(row["severity"]) as CompileDiagnosticDto["severity"],
      code: String(row["code"]) as CompileDiagnosticDto["code"],
      caseId: String(row["case_id"]),
      ...(row["step_ordinal"] === null ? {} : { stepOrdinal: Number(row["step_ordinal"]) }),
      message: String(row["message"]),
    })),
  };
}

/**
 * "Is there anything left to wait for?" — the predicate the SSE stream closes on.
 *
 * Two independent ways to be over, because two different writers get there. `status =
 * 'finished'` is what phase 0 (compile_error) and `abortRun` stamp on the aggregate; "every
 * chain is terminal" is what the fleet reaches one job at a time, and no writer rolls that up
 * onto the aggregate yet. A run with no chain at all is NOT terminal by the second rule — that
 * is a run still compiling, not a finished one.
 */
export function isRunTerminal(run: RunStatusDto): boolean {
  return run.status === "finished" || (run.jobs.length > 0 && run.chainDone === run.jobs.length);
}

/**
 * Cancels a run: every chain that has not finished becomes `cancelled` WITH ITS EPOCH BUMPED,
 * and the aggregate gets its verdict.
 *
 * The epoch bump is the fence. A worker that was mid-chain still holds the old value, so its
 * next `heartbeat`/`events`/`complete` writes 0 rows and it is told to drop everything — see
 * `fenceJob`, which answers `cancelled` (410 JOB_CANCELLED) for exactly this state.
 *
 * The run token is deliberately NOT revoked. Revoking it would turn the worker's next call into
 * a 401, whose prescribed reaction is "exit 1 and re-register" — a restart nobody needs, when
 * the contract already has the precise answer (410: abandon the chain, do NOT complete). The
 * token dies with the lease TTL anyway.
 *
 * On locking: THE JOB ROWS FIRST, THE RUN ROW LAST — the same order `recordRunEvent` takes them
 * in, and the reason it can be taken for granted there. A worker narrating a chain is already
 * holding that chain's job row (`fenceJob`) when it reaches for the run row to allocate an
 * event ordinal; an abort that grabbed the run row first and then went after the job rows would
 * close the cycle, and Postgres would answer a perfectly ordinary "abort during a run" with a
 * deadlock (40P01). Measured in `test/concurrency/run-event-ordinal-race.test.ts`.
 *
 * Nothing is lost by dropping the old `FOR UPDATE` on the run: the cancel is a plain
 * `UPDATE ... WHERE status NOT IN (...)`, and an UPDATE re-evaluates its qualification against
 * the row version it actually locked (unlike a `SELECT ... FOR UPDATE SKIP LOCKED`, whose
 * predicate is answered from the statement's opening snapshot). A claim that flips a row to
 * `running` in between is therefore seen, not skipped — and the run row's own write carries
 * `status <> 'finished'`, which is its own guard against a verdict landing first.
 *
 * `undefined` = no such run for this tenant ⇒ 404. The visibility read takes NO lock: it
 * answers a question about existence, and 404 is not worth a lock ordering hazard.
 */
export async function abortRun(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly runId: string; readonly now: Date },
): Promise<{ readonly cancelledJobs: number } | undefined> {
  const teamId = assertTenantContext(ctx);
  const finishedAt = input.now.toISOString();
  const run = firstRow(
    await tx.execute(sql`
      SELECT id FROM orc_runs WHERE team_id = ${teamId} AND id = ${input.runId}`),
  );
  if (run === undefined) return undefined;

  const cancelled = rowsOf(
    await tx.execute(sql`
      UPDATE job_runs
         SET status = 'cancelled',
             lease_epoch = lease_epoch + 1,
             worker_id = NULL,
             lease_expires_at = NULL,
             finished_at = ${finishedAt}::timestamptz
       WHERE team_id = ${teamId} AND run_id = ${input.runId}
         AND status NOT IN (${TERMINAL_JOB_STATUS_SQL})
      RETURNING id`),
  );

  // `status <> 'finished'` keeps an already-decided run's verdict: a run that passed a second
  // before the abort arrived did pass, and overwriting that would be rewriting history.
  await tx.execute(sql`
    UPDATE orc_runs
       SET status = 'finished', verdict = 'cancelled', finished_at = ${finishedAt}::timestamptz
     WHERE team_id = ${teamId} AND id = ${input.runId} AND status <> 'finished'`);

  return { cancelledJobs: cancelled.length };
}

/**
 * The field maps for the three adapters below.
 *
 * The switch in `toAuthoredStep` is exhaustive on `kind`, so a NEW KIND turns the compiler red on
 * its own. Nothing was watching the other axis — a new FIELD on a kind that already exists — and
 * because every destination field is optional, dropping one compiles fine and shows up as missing
 * data in a report, months later. `FieldMap` is that second axis: every DTO field, optional ones
 * included, must appear in the table below or `satisfies` fails and names it.
 *
 * EXPORTED because a type-level guard cannot prove the function BODY copies what the table names.
 * apps/core/test/arch/adapter-guard.test.ts pins the set of `null` entries — the shape a
 * deliberate drop takes — so dropping a field silently would have to edit a test as well. That set
 * is empty for these three adapters: everything the DTO carries crosses the boundary.
 */
export const ADAPTER_FIELD_MAPS = {
  compileSnapshot: {
    teamId: "teamId",
    projectId: "projectId",
    targetCaseIds: "targetCaseIds",
    cases: "cases",
    elements: "elements",
    dataProfiles: "dataProfiles",
    env: "env",
  } satisfies FieldMap<CompileSnapshotDto, CompileSnapshot>,

  authoredCase: {
    id: "id",
    revisionId: "revisionId",
    name: "name",
    isStepGroup: "isStepGroup",
    prereqCaseId: "prereqCaseId",
    dataProfileId: "dataProfileId",
    steps: "steps",
  } satisfies FieldMap<AuthoredCaseDto, AuthoredCase>,

  /**
   * One table per union member: the DTO's fields differ by `kind`, so a single table would be
   * either too wide (accepting a field on a variant that has none) or too narrow. `AuthoredStep`
   * is one interface with every kind-specific field optional, so `keyof Dst` is the same union
   * for all six.
   */
  authoredStep: {
    action: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      verbOpKey: "verbOpKey",
      args: "args",
      elementId: "elementId",
    } satisfies FieldMap<ActionStepDto, AuthoredStep>,
    stepGroup: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      stepGroupCaseId: "stepGroupCaseId",
    } satisfies FieldMap<StepGroupStepDto, AuthoredStep>,
    if: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      conditionExpected: "conditionExpected",
      children: "children",
    } satisfies FieldMap<IfStepDto, AuthoredStep>,
    for: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      loopDataProfileId: "loopDataProfileId",
      children: "children",
    } satisfies FieldMap<ForStepDto, AuthoredStep>,
    while: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      maxIterations: "maxIterations",
      children: "children",
    } satisfies FieldMap<WhileStepDto, AuthoredStep>,
    rest: {
      kind: "kind",
      ordinal: "ordinal",
      renderedSentence: "renderedSentence",
      args: "args",
    } satisfies FieldMap<RestStepDto, AuthoredStep>,
  },
} as const;

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
 *
 * The fence around the rebuild is `ADAPTER_FIELD_MAPS` right above: a field added to the DTO
 * makes the table incomplete and `pnpm typecheck` fails naming it, instead of the field quietly
 * arriving as `undefined` on the other side.
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
