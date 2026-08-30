/**
 * Phase 0 of the compiler pipeline (blueprint §4): admission → snapshot → compileRun →
 * frozen plan → one `job_runs` row per chain.
 *
 * The load-bearing assertion of the whole file is the compile-error one: a diagnostic with
 * `severity: "error"` must leave the queue EMPTY and the day's budget untouched. A job
 * queued off a run that has no plan would be claimed by a worker that then has nothing to
 * execute, and a burnt quota would punish a team for an error caught before any browser
 * started.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ElementDto } from "@testkite/contract";
import {
  makeTestDb,
  PENDING_LOCATOR_ELEMENT_ID,
  type TestDb,
} from "../harness/pglite.js";
import {
  jobCost,
  startRun,
  type StartRunDeps,
} from "../../src/modules/orchestration/run-service.js";

/**
 * The elements/testdata modules only land in M4, so phase 0 takes both loaders as injection
 * ports. This stub answers every id the snapshot asks for, and the id decides the answer:
 * the one `seedCaseWithPendingLocator` uses comes back with no locator, everything else
 * comes back ready. One deps object therefore drives both the happy path and the
 * compile-error path.
 */
const DEPS: StartRunDeps = {
  loadElements: async (ids: readonly string[]): Promise<Record<string, ElementDto>> =>
    Object.fromEntries(
      ids.map((id): readonly [string, ElementDto] => [
        id,
        id === PENDING_LOCATOR_ELEMENT_ID
          ? { id, name: "checkout button", status: "pending_locator", locators: [] }
          : { id, name: `element ${id}`, status: "ready", locators: [{ kind: "css", value: `#${id}` }] },
      ]),
    ),
  loadDataProfiles: async () => ({}),
};

const now = new Date("2026-08-30T09:00:00Z");

describe("startRun — compiler phase 0", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await makeTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  it("freezes one plan and creates exactly one job_run per chain", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 2); // two independent chains
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        {
          projectId: a.projectId,
          targetCaseIds: caseIds,
          lane: "batch",
          pin: "latest",
          requestedBy: a.userId,
          now,
        },
        DEPS,
      ),
    );
    expect(res.kind).toBe("queued");
    const jobs = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT status, chain_key, cost FROM job_runs ORDER BY chain_key`),
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.every((r) => r["status"] === "pending")).toBe(true);
    // chain_key is the target case id (phase 1), so the two chains are exactly the targets.
    expect(jobs.rows.map((r) => String(r["chain_key"])).sort()).toEqual([...caseIds].sort());
    // 3 static step nodes per chain (the action, the `if`, its child) => clamp(ceil(3/10), 1, 8) = 1.
    expect(jobs.rows.map((r) => Number(r["cost"]))).toEqual([1, 1]);
    const plan = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT content_hash, plan_format_version FROM orc_run_plans`),
    );
    expect(String(plan.rows[0]?.["content_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(plan.rows[0]?.["plan_format_version"])).toBe(1);
    const run = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT status, verdict, plan_hash, chain_total FROM orc_runs`),
    );
    expect(run.rows[0]).toMatchObject({ status: "queued", verdict: "pending", chain_total: 2 });
    expect(res.kind === "queued" && run.rows[0]?.["plan_hash"] === res.planHash).toBe(true);
  });

  it("compiles a prereq chain into ONE job whose frozen plan carries both cases, ancestor first", async () => {
    const [a] = await t.seedTwoTeams();
    const [prereq = ""] = await t.seedRunnableCases(a, 1);
    const [target = ""] = await t.seedRunnableCases(a, 1, { prereqCaseId: prereq });
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        { projectId: a.projectId, targetCaseIds: [target], lane: "batch", pin: "latest", requestedBy: a.userId, now },
        DEPS,
      ),
    );
    // A prereq does NOT get a job of its own: the chain is the unit of work, and its two
    // cases share one browser context, one lease, one verdict.
    expect(res).toMatchObject({ kind: "queued", chainCount: 1 });
    const jobs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT chain_key FROM job_runs`));
    expect(jobs.rows).toHaveLength(1);
    expect(String(jobs.rows[0]?.["chain_key"])).toBe(target);
    const frozen = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`
        SELECT jsonb_array_length(plan->'chains') AS chain_count,
               plan->'chains'->0->>'chainKey' AS chain_key,
               (SELECT jsonb_agg(c->>'caseId')
                  FROM jsonb_array_elements(plan->'chains'->0->'cases') c) AS case_ids
          FROM orc_run_plans`),
    );
    expect(Number(frozen.rows[0]?.["chain_count"])).toBe(1);
    expect(String(frozen.rows[0]?.["chain_key"])).toBe(target);
    expect(frozen.rows[0]?.["case_ids"]).toEqual([prereq, target]);
  });

  it("is deterministic: compiling the same cases twice yields the same content_hash", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 1);
    const first = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        { projectId: a.projectId, targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now },
        DEPS,
      ),
    );
    const second = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        { projectId: a.projectId, targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now },
        DEPS,
      ),
    );
    expect(first.kind === "queued" && second.kind === "queued" && first.planHash === second.planHash).toBe(true);
    // Two runs, two plan rows, one hash: the hash names the CONTENT, not the run.
    expect(first.kind === "queued" && second.kind === "queued" && first.runId !== second.runId).toBe(true);
  });

  it("creates NO job at all when the compiler reports an error, and refunds the quota", async () => {
    const [a] = await t.seedTwoTeams();
    const broken = await t.seedCaseWithPendingLocator(a); // element_pending_locator
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 1 WHERE team_id = ${a.teamId}`);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        { projectId: a.projectId, targetCaseIds: [broken], lane: "batch", pin: "latest", requestedBy: a.userId, now },
        DEPS,
      ),
    );
    expect(res.kind).toBe("compile_error");
    const jobs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM job_runs`));
    expect(Number(jobs.rows[0]?.["n"]), "a compile error must never queue work").toBe(0);
    const run = await t.asTeam(a.teamId, (tx) =>
      tx.execute(sql`SELECT status, verdict, plan_hash FROM orc_runs`),
    );
    expect(run.rows[0]).toMatchObject({ status: "finished", verdict: "compile_error", plan_hash: null });
    const plans = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_run_plans`));
    expect(Number(plans.rows[0]?.["n"]), "no plan exists when a diagnostic is an error").toBe(0);
    const diags = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT code FROM orc_compile_diagnostics`));
    expect(diags.rows.map((r) => String(r["code"]))).toContain("element_pending_locator");
    // The quota went back: a second run on the same day is still allowed.
    const used = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT used FROM usage_counters`));
    expect(Number(used.rows[0]?.["used"])).toBe(0);
  });

  it("refuses over-quota BEFORE compiling anything", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 1);
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 0 WHERE team_id = ${a.teamId}`);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(
        tx,
        ctx,
        { projectId: a.projectId, targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now },
        DEPS,
      ),
    );
    expect(res).toMatchObject({ kind: "rejected_quota", used: 0, limit: 0 });
    const runs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_runs`));
    expect(Number(runs.rows[0]?.["n"])).toBe(0);
  });

  it("404s a case belonging to another team instead of leaking its existence", async () => {
    const [a, b] = await t.seedTwoTeams();
    // Team A is fully set up on purpose: the only thing that can 404 is the foreign case.
    await t.seedRunnableCases(a, 1);
    const foreign = (await t.seedRunnableCases(b, 1))[0] ?? "";
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) =>
        startRun(
          tx,
          ctx,
          { projectId: a.projectId, targetCaseIds: [foreign], lane: "batch", pin: "latest", requestedBy: a.userId, now },
          DEPS,
        ),
      ),
    ).rejects.toMatchObject({ httpStatus: 404 });
    // The whole of phase 0 is one transaction: the rejected run left nothing behind, not
    // even the quota it had already reserved.
    const runs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_runs`));
    expect(Number(runs.rows[0]?.["n"])).toBe(0);
    const used = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM usage_counters`));
    expect(Number(used.rows[0]?.["n"])).toBe(0);
  });

  it("computes job cost as clamp(ceil(steps/10), 1, 8)", () => {
    expect([jobCost(0), jobCost(1), jobCost(10), jobCost(11), jobCost(80), jobCost(500)]).toEqual([
      1, 1, 1, 2, 8, 8,
    ]);
  });
});
