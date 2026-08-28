/**
 * Phase 1 — resolves the prereq chain into a CHAIN (the fleet's unit of job).
 *
 * Semantics (blueprint §2, deliberately inherited from the verified old system):
 *  - a prereq is a case-calls-case chain; execution order: farthest ancestor first.
 *  - a cycle is rejected; max ANCESTOR count is 5 (the old "allowed limit of 5" rule).
 *  - each target is ONE independent chain — a shared prereq does not run shared
 *    (each chain gets a new BrowserContext; isolation is a feature, not overhead).
 *  - COLLECT errors: a broken target produces a diagnostic, a healthy target still yields a chain.
 */
import type { CompileDiagnostic } from "./index.js";
import type { AuthoredCase, CompileSnapshot } from "./snapshot.js";

export const MAX_PREREQ_ANCESTORS = 5;

export interface ResolvedChain {
  readonly chainKey: string;
  /** Execution order: [farthest ancestor, ..., target]. */
  readonly caseIds: readonly string[];
}

export interface ChainResolution {
  readonly chains: readonly ResolvedChain[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

export function resolveChains(snapshot: CompileSnapshot): ChainResolution {
  const chains: ResolvedChain[] = [];
  const diagnostics: CompileDiagnostic[] = [];

  for (const targetId of snapshot.targetCaseIds) {
    const lineage: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = targetId;
    let failed = false;

    while (currentId !== undefined) {
      if (seen.has(currentId)) {
        diagnostics.push({
          severity: "error",
          code: "prereq_cycle",
          caseId: targetId,
          message: `Prereq chain of "${targetId}" contains a cycle at "${currentId}"`,
        });
        failed = true;
        break;
      }
      seen.add(currentId);

      const current: AuthoredCase | undefined = snapshot.cases[currentId];
      if (current === undefined) {
        diagnostics.push({
          severity: "error",
          code: "prereq_missing",
          caseId: targetId,
          message: `Prereq "${currentId}" of "${targetId}" does not exist in the snapshot`,
        });
        failed = true;
        break;
      }

      lineage.unshift(currentId);
      currentId = current.prereqCaseId;
    }

    if (failed) continue;

    const ancestorCount = lineage.length - 1;
    if (ancestorCount > MAX_PREREQ_ANCESTORS) {
      diagnostics.push({
        severity: "error",
        code: "prereq_depth_exceeded",
        caseId: targetId,
        message: `Prereq chain of "${targetId}" has ${ancestorCount} ancestors — exceeds the cap of ${MAX_PREREQ_ANCESTORS}`,
      });
      continue;
    }

    chains.push({ chainKey: targetId, caseIds: lineage });
  }

  return { chains, diagnostics };
}
