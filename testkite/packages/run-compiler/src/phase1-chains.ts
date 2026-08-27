/**
 * Phase 1 — resolve chuỗi prereq thành CHAIN (đơn vị job của fleet).
 *
 * Ngữ nghĩa (blueprint §2, kế thừa có chủ đích từ hệ cũ đã xác minh):
 *  - prereq là chuỗi case-gọi-case; thứ tự chạy: tổ tiên xa nhất trước.
 *  - cycle bị từ chối; số TỔ TIÊN tối đa 5 (luật "allowed limit of 5" cũ).
 *  - Mỗi target là MỘT chain độc lập — prereq chung không chạy chung
 *    (mỗi chain một BrowserContext mới; cô lập là tính năng, không phải phí).
 *  - GOM lỗi: target hỏng sinh diagnostic, target lành vẫn ra chain.
 */
import type { CompileDiagnostic } from "./index.js";
import type { AuthoredCase, CompileSnapshot } from "./snapshot.js";

export const MAX_PREREQ_ANCESTORS = 5;

export interface ResolvedChain {
  readonly chainKey: string;
  /** Thứ tự thực thi: [tổ tiên xa nhất, ..., target]. */
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
          message: `Chuỗi prereq của "${targetId}" chứa vòng lặp tại "${currentId}"`,
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
          message: `Prereq "${currentId}" của "${targetId}" không tồn tại trong snapshot`,
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
        message: `Chuỗi prereq của "${targetId}" có ${ancestorCount} tổ tiên — vượt trần ${MAX_PREREQ_ANCESTORS}`,
      });
      continue;
    }

    chains.push({ chainKey: targetId, caseIds: lineage });
  }

  return { chains, diagnostics };
}
