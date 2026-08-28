/**
 * @testkite/run-compiler — the HEART of TestKite (docs/SYSTEM_DESIGN.md §4).
 *
 * Pure function: (scope, an authoring data snapshot) → an IMMUTABLE, content-hashed RunPlan.
 * - The worker NEVER reads authoring tables — it only receives a frozen plan.
 * - Every error (a verb not yet ported, element pending_locator, a prereq cycle) is caught
 *   BEFORE any browser starts → verdict=compile_error, quota refunded.
 * - Golden test (T1): same input ⇒ same content_hash, every CompileErrorCode has a negative fixture.
 *
 * 9 phases (0 and 7.5–9 live in orchestration; this package is purely 1→7):
 *  1. resolve the prereq chain (cycle check, depth ≤ 5, PIN THE REVISION —
 *     schedule/CI runs the 'ready' version: a QA's midnight edit doesn't change what's
 *     in flight)                                                          → phase1-chains.ts
 *  2. expand structure: inline step groups ≤ 5 deep (local | subscribed frozen snapshot),
 *     if/loop → block tree, data-driven fan-out + expected_to_fail          → phase2-expand.ts
 *  3. bind verb → op registry (COLLECT EVERY ERROR, no first-fail)          → phase3-bind.ts
 *  4. element → LocatorSet (pending_locator ⇒ its own diagnostic)           → phase45-resolve.ts
 *  5. merge data/env; a secret is ONLY a $secretRef — never the value       → phase45-resolve.ts
 *  6. stamp policy/tenant (timeout, retry=infra-only, screenshots per lane) → phase67-freeze.ts
 *  7. freeze: canonicalize → SHA-256 → planFormatVersion (zstd: TODO M2)    → phase67-freeze.ts
 */
import type { CompileErrorCode } from "@testkite/contract";
import { resolveChains } from "./phase1-chains.js";
import { expandCases } from "./phase2-expand.js";
import { bindCases } from "./phase3-bind.js";
import { resolveCases } from "./phase45-resolve.js";
import { freezePlan } from "./phase67-freeze.js";
import type { FrozenChain, RunLane, ScreenshotPolicy } from "./phase67-freeze.js";
import type { CompileSnapshot } from "./snapshot.js";

/**
 * The compile error catalog LIVES IN `@testkite/contract` (the API boundary and the
 * compiler must share one list; contract can't import back, so contract owns it).
 * Re-exported here so every existing call site — including the golden suite — doesn't
 * have to change its import.
 */
export { COMPILE_ERROR_CODES } from "@testkite/contract";
export type { CompileErrorCode } from "@testkite/contract";

export interface CompileDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: CompileErrorCode;
  readonly caseId: string;
  readonly stepOrdinal?: number;
  readonly message: string;
}

// Public surface of the plan — owned by the type from the phase that generates it, index only re-exports.
export { PLAN_FORMAT_VERSION, canonicalJson, chainTimeoutSeconds, contentHashOf, countSteps, freezePlan } from "./phase67-freeze.js";
export type {
  CasePlan,
  ChainPlan,
  RunLane,
  RunPlan,
  RunPolicy,
  ScreenshotPolicy,
  StepPlan,
} from "./phase67-freeze.js";
export type { LocatorSet, ResolvedActionStep, ResolvedBlockStep } from "./phase45-resolve.js";
export type * from "./snapshot.js";

import type { RunPlan } from "./phase67-freeze.js";

export interface CompileInput {
  /** A pre-fetched authoring snapshot — the compiler does NOT query the DB itself; that's what keeps the function pure. */
  readonly snapshot: CompileSnapshot;
  /** Absent ⇒ "batch" (the nightly/CI run path). */
  readonly lane?: RunLane;
  /** Per-run override; absent ⇒ defaults by lane (§5.2). */
  readonly screenshots?: ScreenshotPolicy;
}

export interface CompileOutput {
  readonly plan?: RunPlan; // undefined when there's at least 1 diagnostic with severity=error
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * Runs the full phase 1→7 pipeline.
 *
 * Two rules govern this function's shape:
 *  - COLLECT EVERY ERROR, no first-fail: every phase runs to completion on every chain,
 *    diagnostics accumulate. The author fixes everything in ONE pass, not 6 recompiles to
 *    surface 6 errors.
 *  - ≥1 `severity: "error"` ⇒ NO plan is produced. A half-baked plan is more dangerous than
 *    no plan at all: it can run, burn browser money, then fail on something already known
 *    at compile-time.
 *
 * Diagnostics are ordered by PHASE FLOW (every phase-3 error for a chain, then every
 * phase-4+5 error), not by case — reads like a compiler's output, not a shuffled error list.
 */
export function compileRun(input: CompileInput): CompileOutput {
  const { snapshot } = input;
  const diagnostics: CompileDiagnostic[] = [];
  const chains: FrozenChain[] = [];

  const chainResolution = resolveChains(snapshot); // phase 1
  diagnostics.push(...chainResolution.diagnostics);

  for (const chain of chainResolution.chains) {
    const expansion = expandCases(snapshot, chain.caseIds); // phase 2
    diagnostics.push(...expansion.diagnostics);

    const binding = bindCases(expansion.cases); // phase 3
    diagnostics.push(...binding.diagnostics);

    const resolution = resolveCases(binding.cases, snapshot); // phase 4+5
    diagnostics.push(...resolution.diagnostics);

    chains.push({ chainKey: chain.chainKey, cases: resolution.cases });
  }

  const unique = dedupeDiagnostics(diagnostics);
  if (unique.some((d) => d.severity === "error")) return { diagnostics: unique };

  return {
    plan: freezePlan({
      // phase 6+7
      teamId: snapshot.teamId,
      projectId: snapshot.projectId,
      baseUrl: snapshot.env.baseUrl,
      lane: input.lane ?? "batch",
      chains,
      ...(input.screenshots === undefined ? {} : { screenshots: input.screenshots }),
    }),
    diagnostics: unique,
  };
}

/**
 * A chain is an ISOLATED unit: a `login` prereq shared by 5 targets gets expanded 5 times,
 * so a broken element inside `login` produces 5 IDENTICAL diagnostics. The author only needs
 * to know `login` is broken ONCE — an exact duplicate carries no extra information.
 *
 * The dedup key must be a BIJECTION over the field set. Joining fields with a separator isn't:
 * `caseId` comes from the legacy dump and `message` is free text, so either one could contain
 * the exact character acting as the separator — two different errors collapse to the same key
 * and a real error vanishes from the output. `JSON.stringify` of the field array is unambiguous:
 * every character in a string is escaped, and the boundary between elements is structural, not
 * a convention.
 */
export function dedupeDiagnostics(all: readonly CompileDiagnostic[]): readonly CompileDiagnostic[] {
  const seen = new Set<string>();
  const out: CompileDiagnostic[] = [];

  for (const d of all) {
    const key = JSON.stringify([d.severity, d.code, d.caseId, d.stepOrdinal ?? null, d.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  return out;
}
