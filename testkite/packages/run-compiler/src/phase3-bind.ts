/**
 * Phase 3 — bind verb (blueprint §4): ExpandedStep (IR cấu trúc) → BoundStep (IR đã có op).
 *
 * Đây là chỗ thay thế `Class.forName(...)` của hệ cũ: verb không còn được resolve lúc
 * runtime bằng phản chiếu tên class (lỗi lộ ra khi browser đã chạy nửa suite), mà tra
 * registry của @testkite/verb-kit ngay lúc compile — sai op key hoặc thiếu param là
 * `compile_error`, chưa tốn một giây browser nào.
 *
 * Hai luật:
 *  - GOM MỌI LỖI: một step hỏng không dừng phase; step hỏng bị LOẠI khỏi IR để type
 *    `BoundActionStep` giữ được bất biến "opKey đã tồn tại + args đã hợp lệ" (plan chỉ
 *    được sinh khi diagnostics rỗng, nên loại step không bao giờ làm mất dữ liệu plan).
 *  - Node cấu trúc (if/for/while/rest) KHÔNG bind verb — chỉ duyệt đệ quy children,
 *    giữ nguyên dữ liệu tĩnh phase 2 đã resolve (loopRows, maxIterations, điều kiện).
 */
import { getVerb, validateArgs } from "@testkite/verb-kit";
import type { CompileDiagnostic } from "./index.js";
import type { ExpandedCase, ExpandedStep, ExpandedStepKind } from "./phase2-expand.js";
import type { DataRow } from "./snapshot.js";

interface BoundStepCommon {
  readonly ordinal: number;
  readonly renderedSentence: string;
  /** Provenance step-group từ phase 2 — giữ nguyên để QA truy ngược nguồn step. */
  readonly groupPath: readonly string[];
  readonly args: Readonly<Record<string, string>>;
}

/** Step đã bind: opKey CHẮC CHẮN có trong registry và args CHẮC CHẮN hợp lệ với verb đó. */
export interface BoundActionStep extends BoundStepCommon {
  readonly kind: "action";
  readonly opKey: string;
  /** Tham chiếu element — phase 4 mới đổi thành LocatorSet. */
  readonly elementId?: string;
}

export interface BoundBlockStep extends BoundStepCommon {
  readonly kind: Exclude<ExpandedStepKind, "action">;
  readonly children: readonly BoundStep[];
  readonly conditionExpected?: readonly string[];
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
}

export type BoundStep = BoundActionStep | BoundBlockStep;

export interface BoundCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly BoundStep[];
  readonly iterationLabel?: string;
  readonly dataRow?: Readonly<Record<string, string>>;
}

export interface Binding {
  readonly cases: readonly BoundCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/** Bind toàn bộ case của MỘT chain (thứ tự đầu vào = thứ tự thực thi, giữ nguyên). */
export function bindCases(cases: readonly ExpandedCase[]): Binding {
  const out: BoundCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  /**
   * Fan-out data-driven cho N iteration DÙNG CHUNG một cây step: bind một lần rồi tái
   * dùng — nếu không, verb lạ trong case 500 hàng sẽ đẻ ra 500 diagnostic giống hệt.
   */
  const boundByCase = new Map<string, readonly BoundStep[]>();

  for (const expanded of cases) {
    let steps = boundByCase.get(expanded.caseId);
    if (steps === undefined) {
      steps = bindSteps(expanded.steps, expanded.caseId, diagnostics);
      boundByCase.set(expanded.caseId, steps);
    }

    out.push({
      caseId: expanded.caseId,
      revisionId: expanded.revisionId,
      expectedToFail: expanded.expectedToFail,
      steps,
      ...(expanded.iterationLabel === undefined ? {} : { iterationLabel: expanded.iterationLabel }),
      ...(expanded.dataRow === undefined ? {} : { dataRow: expanded.dataRow }),
    });
  }

  return { cases: out, diagnostics };
}

function bindSteps(
  steps: readonly ExpandedStep[],
  caseId: string,
  diagnostics: CompileDiagnostic[],
): readonly BoundStep[] {
  const out: BoundStep[] = [];

  for (const step of steps) {
    if (step.kind !== "action") {
      out.push({
        ordinal: step.ordinal,
        kind: step.kind,
        renderedSentence: step.renderedSentence,
        groupPath: step.groupPath,
        args: step.args,
        children: bindSteps(step.children ?? [], caseId, diagnostics),
        ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
        ...(step.loopRows === undefined ? {} : { loopRows: step.loopRows }),
        ...(step.maxIterations === undefined ? {} : { maxIterations: step.maxIterations }),
      });
      continue;
    }

    const opKey = step.verbOpKey;
    if (opKey === undefined || getVerb(opKey) === undefined) {
      diagnostics.push({
        severity: "error",
        code: "unknown_verb",
        caseId,
        stepOrdinal: step.ordinal,
        message: `Verb "${opKey ?? "(không khai báo)"}" không có trong registry @testkite/verb-kit — chưa port hoặc sai op key`,
      });
      continue;
    }

    const check = validateArgs(opKey, argsForCheck(step));
    if (!check.ok) {
      diagnostics.push({
        severity: "error",
        code: "verb_args_invalid",
        caseId,
        stepOrdinal: step.ordinal,
        message: `Args của verb "${opKey}" không hợp lệ: ${check.issues.join("; ")}`,
      });
      continue;
    }

    out.push({
      ordinal: step.ordinal,
      kind: "action",
      renderedSentence: step.renderedSentence,
      groupPath: step.groupPath,
      args: step.args,
      opKey,
      ...(step.elementId === undefined ? {} : { elementId: step.elementId }),
    });
  }

  return out;
}

/**
 * Element của step nằm ở cột riêng (`elementId`), không ở args — nhưng verb khai báo nó
 * như một param. Nối lại chỉ để KIỂM: args gốc của tác giả giữ nguyên trong IR, phase 4
 * mới là nơi biến elementId thành LocatorSet.
 */
function argsForCheck(step: ExpandedStep): Record<string, string> {
  const { elementId } = step;
  if (elementId === undefined || "element" in step.args) return { ...step.args };
  return { ...step.args, element: elementId };
}
