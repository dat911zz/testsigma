/**
 * Phase 2 — nở cấu trúc (blueprint §4): AuthoredStep (cây tác giả) → ExpandedStep (IR cấu trúc).
 *
 * Ba phép nở, đúng ngữ nghĩa đã xác minh của hệ cũ:
 *  - step_group: INLINE tại chỗ (group = case có isStepGroup) — step con giữ nguyên
 *    renderedSentence gốc, mang thêm provenance `groupPath` để QA truy ngược nguồn step.
 *    Trần lồng 5 tầng; group tự gọi mình rơi vào chính trần đó (cycle bắt qua depth).
 *  - if/for/while: GIỮ là node có children (worker mới là nơi quyết định nhánh/lặp thật) —
 *    compiler chỉ resolve dữ liệu tĩnh: `for` gắn sẵn các DataRow, `while` bắt buộc có trần lặp.
 *  - data-driven ở cấp case: fan-out mỗi DataRow thành MỘT iteration (label + expected_to_fail).
 *
 * GOM lỗi: một step hỏng không dừng phase — mọi diagnostic của mọi case được thu đủ.
 */
import type { CompileDiagnostic } from "./index.js";
import type { AuthoredStep, CompileSnapshot, DataRow } from "./snapshot.js";

/** Trần lồng step group — kế thừa luật "allowed limit of 5" của hệ cũ. */
export const MAX_STEP_GROUP_DEPTH = 5;

/** step_group biến mất sau phase 2 (đã inline); các kind còn lại đi tiếp xuống plan. */
export type ExpandedStepKind = "action" | "if" | "for" | "while" | "rest";

export interface ExpandedStep {
  /** Ordinal trong case/group CHỨA step — dùng để chỉ mặt lỗi cho tác giả. */
  readonly ordinal: number;
  readonly kind: ExpandedStepKind;
  readonly renderedSentence: string;
  /** Chuỗi id step-group đã inline để tới step này; rỗng = step viết thẳng trong case. */
  readonly groupPath: readonly string[];
  readonly args: Readonly<Record<string, string>>;
  readonly verbOpKey?: string;
  readonly elementId?: string;
  readonly conditionExpected?: readonly string[];
  /** kind=for: dữ liệu lặp đã resolve từ profile (bất biến trong plan). */
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
  readonly children?: readonly ExpandedStep[];
}

export interface ExpandedCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly ExpandedStep[];
  /** data-driven: nhãn hàng dữ liệu của iteration này. */
  readonly iterationLabel?: string;
  /** data-driven: giá trị hàng — phase 5 merge vào args. */
  readonly dataRow?: Readonly<Record<string, string>>;
}

export interface Expansion {
  readonly cases: readonly ExpandedCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

interface ExpandCtx {
  readonly snapshot: CompileSnapshot;
  /** Case gốc đang nở — diagnostic luôn quy về case QA thấy, không phải group nội bộ. */
  readonly caseId: string;
  readonly diagnostics: CompileDiagnostic[];
}

/** Nở một danh sách case (thường là các case của MỘT chain, theo thứ tự thực thi). */
export function expandCases(snapshot: CompileSnapshot, caseIds: readonly string[]): Expansion {
  const cases: ExpandedCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];

  for (const caseId of caseIds) {
    const authored = snapshot.cases[caseId];
    if (authored === undefined) continue; // phase 1 đã báo prereq_missing

    const ctx: ExpandCtx = { snapshot, caseId, diagnostics };
    const steps = expandSteps(authored.steps, ctx, []);

    const profileId = authored.dataProfileId;
    if (profileId === undefined) {
      cases.push({ caseId, revisionId: authored.revisionId, expectedToFail: false, steps });
      continue;
    }

    const rows = snapshot.dataProfiles[profileId]?.rows ?? [];
    if (rows.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "data_profile_empty",
        caseId,
        message: `Case "${caseId}" chạy theo data profile "${profileId}" nhưng profile rỗng hoặc không có trong snapshot`,
      });
      continue;
    }

    for (const row of rows) {
      cases.push({
        caseId,
        revisionId: authored.revisionId,
        expectedToFail: row.expectedToFail,
        steps,
        iterationLabel: row.label,
        dataRow: row.values,
      });
    }
  }

  return { cases, diagnostics };
}

function expandSteps(
  steps: readonly AuthoredStep[],
  ctx: ExpandCtx,
  groupPath: readonly string[],
): readonly ExpandedStep[] {
  const out: ExpandedStep[] = [];

  for (const step of steps) {
    if (step.kind === "step_group") {
      out.push(...inlineGroup(step, ctx, groupPath));
      continue;
    }

    const children =
      step.children === undefined ? undefined : expandSteps(step.children, ctx, groupPath);

    out.push({
      ordinal: step.ordinal,
      kind: step.kind,
      renderedSentence: step.renderedSentence,
      groupPath,
      args: step.args ?? {},
      ...(step.verbOpKey === undefined ? {} : { verbOpKey: step.verbOpKey }),
      ...(step.elementId === undefined ? {} : { elementId: step.elementId }),
      ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
      ...(children === undefined ? {} : { children }),
      ...(step.kind === "for" ? loopRowsOf(step, ctx) : {}),
      ...(step.kind === "while" ? maxIterationsOf(step, ctx) : {}),
    });
  }

  return out;
}

function inlineGroup(
  step: AuthoredStep,
  ctx: ExpandCtx,
  groupPath: readonly string[],
): readonly ExpandedStep[] {
  const targetId = step.stepGroupCaseId;
  const target = targetId === undefined ? undefined : ctx.snapshot.cases[targetId];

  if (targetId === undefined || target === undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "step_group_missing",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Step group "${targetId ?? "(không khai báo)"}" không tồn tại trong snapshot`,
    });
    return [];
  }

  if (groupPath.length >= MAX_STEP_GROUP_DEPTH) {
    ctx.diagnostics.push({
      severity: "error",
      code: "step_group_depth_exceeded",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Nở step group "${targetId}" vượt trần ${MAX_STEP_GROUP_DEPTH} tầng (đường nở: ${[...groupPath, targetId].join(" → ")})`,
    });
    return [];
  }

  return expandSteps(target.steps, ctx, [...groupPath, targetId]);
}

function loopRowsOf(step: AuthoredStep, ctx: ExpandCtx): { loopRows?: readonly DataRow[] } {
  const profileId = step.loopDataProfileId;
  const rows = profileId === undefined ? [] : (ctx.snapshot.dataProfiles[profileId]?.rows ?? []);
  if (rows.length === 0) {
    ctx.diagnostics.push({
      severity: "error",
      code: "data_profile_empty",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Vòng lặp "for" cần data profile có ít nhất 1 hàng (profile: ${profileId ?? "không khai báo"})`,
    });
    return {};
  }
  return { loopRows: rows };
}

function maxIterationsOf(step: AuthoredStep, ctx: ExpandCtx): { maxIterations?: number } {
  if (step.maxIterations === undefined) {
    ctx.diagnostics.push({
      severity: "error",
      code: "while_without_max_iterations",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Vòng lặp "while" phải khai báo maxIterations — không có trần lặp là vé vào treo vô hạn`,
    });
    return {};
  }
  return { maxIterations: step.maxIterations };
}
