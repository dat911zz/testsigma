/**
 * Phase 4+5 — element → LocatorSet, rồi merge data/env (blueprint §4):
 * BoundStep (đã có op) → ResolvedStep (đã có locator + args cuối cùng).
 *
 * Phase 4 — element:
 *  Hệ cũ nối step với element bằng TÊN CHUỖI, sai tên chỉ lộ ra khi browser đã mở. Ở đây
 *  `elementId` được tra thẳng snapshot lúc compile: không có ⇒ `element_not_found`; có mà
 *  chưa chụp được locator ⇒ `element_pending_locator`. Step tốt mang theo `LocatorSet` bất
 *  biến — worker KHÔNG BAO GIỜ đọc bảng element lúc chạy (QA sửa element giữa đêm không
 *  làm đổi thứ đang bay).
 *
 * Phase 5 — data/env:
 *  Arg do tác giả viết có thể là REF nguyên chuỗi, ba họ:
 *   - `$data:<cột>` → giá trị từ hàng dữ liệu của CHÍNH iteration này (fan-out ở phase 2).
 *   - `$env:<biến>`  → giá trị từ `env.vars`.
 *   - `$secret:<tên>` → GIỮ NGUYÊN DẠNG REF. Compiler chỉ kiểm tên có trong `env.secretNames`
 *     (`secret_ref_unknown`) — giá trị secret KHÔNG BAO GIỜ được inline vào plan, vì plan là
 *     payload bất biến bị hash, lưu trữ và gửi cho worker.
 *
 *  Hai luật thay thế, cố ý hẹp:
 *   - Chỉ thay khi TOÀN BỘ arg là ref (không nội suy giữa chuỗi) — không có cú pháp thoát
 *     nào phải phát minh, và chuỗi chứa `$` của tác giả không bao giờ bị hiểu nhầm.
 *   - ĐÚNG MỘT PASS: giá trị vừa thay không được diễn giải lại. Dữ liệu test do đó không
 *     thể tự viết mình thành một secret ref để moi giá trị.
 *  Ref trỏ tên không biết được GIỮ NGUYÊN (không phải lỗi): trong thân vòng `for`, cột dữ
 *  liệu thuộc về hàng lặp mà chỉ worker mới biết — compiler chưa có gì để thay.
 *
 * GOM lỗi như các phase trước: step action hỏng bị LOẠI khỏi IR (mọi lỗi của nó được báo
 * đủ trước khi loại), node cấu trúc thì GIỮ để lỗi của children vẫn được thu.
 */
import type { CompileDiagnostic } from "./index.js";
import type { BoundActionStep, BoundCase, BoundStep } from "./phase3-bind.js";
import type { CompileSnapshot, DataRow, ElementSnapshot, EnvSnapshot } from "./snapshot.js";

/** Bộ locator đã ghim vào plan — worker chạy bằng đúng cái này, không tra lại DB. */
export interface LocatorSet {
  readonly elementId: string;
  readonly elementName: string;
  readonly locators: ElementSnapshot["locators"];
}

interface ResolvedStepCommon {
  readonly ordinal: number;
  readonly renderedSentence: string;
  readonly groupPath: readonly string[];
  /** Args cuối cùng: data/env đã thay, secret vẫn là `$secret:<tên>`. */
  readonly args: Readonly<Record<string, string>>;
}

export interface ResolvedActionStep extends ResolvedStepCommon {
  readonly kind: "action";
  readonly opKey: string;
  /** Vắng mặt khi verb không thao tác trên element nào. */
  readonly locators?: LocatorSet;
}

export interface ResolvedBlockStep extends ResolvedStepCommon {
  readonly kind: Exclude<BoundStep["kind"], "action">;
  readonly children: readonly ResolvedStep[];
  readonly conditionExpected?: readonly string[];
  readonly loopRows?: readonly DataRow[];
  readonly maxIterations?: number;
}

export type ResolvedStep = ResolvedActionStep | ResolvedBlockStep;

export interface ResolvedCase {
  readonly caseId: string;
  readonly revisionId: string;
  readonly expectedToFail: boolean;
  readonly steps: readonly ResolvedStep[];
  readonly iterationLabel?: string;
}

export interface Resolution {
  readonly cases: readonly ResolvedCase[];
  readonly diagnostics: readonly CompileDiagnostic[];
}

/** Ref chiếm TRỌN arg; tên cột/biến giữ nguyên khoảng trắng ("Họ Tên" là tên cột hợp lệ). */
const ARG_REF = /^\$(secret|data|env):(.+)$/;

type ArgRefKind = "secret" | "data" | "env";

interface ResolveCtx {
  readonly env: EnvSnapshot;
  readonly elements: CompileSnapshot["elements"];
  readonly caseId: string;
  readonly dataRow: Readonly<Record<string, string>>;
  /** Nơi đổ diagnostic; iteration thứ 2 trở đi của cùng case đổ vào thùng rác (xem dưới). */
  readonly diagnostics: CompileDiagnostic[];
}

/**
 * Resolve toàn bộ case đã bind của MỘT chain.
 *
 * Fan-out data-driven: mỗi iteration phải có args RIÊNG (đó là toàn bộ ý nghĩa của
 * data-driven), nên không tái dùng cây step như phase 3 được. Nhưng lỗi element/secret thì
 * độc lập với hàng dữ liệu — chỉ thu diagnostic ở iteration ĐẦU của mỗi case, nếu không một
 * element hỏng trong case 500 hàng sẽ đẻ ra 500 diagnostic giống hệt.
 */
export function resolveCases(cases: readonly BoundCase[], snapshot: CompileSnapshot): Resolution {
  const out: ResolvedCase[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const alreadyDiagnosed = new Set<string>();

  for (const bound of cases) {
    const firstIteration = !alreadyDiagnosed.has(bound.caseId);
    alreadyDiagnosed.add(bound.caseId);

    const ctx: ResolveCtx = {
      env: snapshot.env,
      elements: snapshot.elements,
      caseId: bound.caseId,
      dataRow: bound.dataRow ?? {},
      diagnostics: firstIteration ? diagnostics : [],
    };

    out.push({
      caseId: bound.caseId,
      revisionId: bound.revisionId,
      expectedToFail: bound.expectedToFail,
      steps: resolveSteps(bound.steps, ctx),
      ...(bound.iterationLabel === undefined ? {} : { iterationLabel: bound.iterationLabel }),
    });
  }

  return { cases: out, diagnostics };
}

function resolveSteps(steps: readonly BoundStep[], ctx: ResolveCtx): readonly ResolvedStep[] {
  const out: ResolvedStep[] = [];

  for (const step of steps) {
    // Lỗi của MỘT step gom riêng rồi mới đổ ra, để step hỏng vẫn báo đủ mọi lỗi của nó —
    // theo đúng thứ tự phase (element trước, args sau) để diagnostic đọc như dòng chảy compiler.
    const stepDiagnostics: CompileDiagnostic[] = [];
    const locators = step.kind === "action" ? resolveElement(step, ctx, stepDiagnostics) : undefined;
    const args = mergeArgs(step.args, ctx, step.ordinal, stepDiagnostics);

    if (step.kind !== "action") {
      ctx.diagnostics.push(...stepDiagnostics);
      out.push({
        ordinal: step.ordinal,
        kind: step.kind,
        renderedSentence: step.renderedSentence,
        groupPath: step.groupPath,
        args,
        children: resolveSteps(step.children, ctx),
        ...(step.conditionExpected === undefined ? {} : { conditionExpected: step.conditionExpected }),
        ...(step.loopRows === undefined ? {} : { loopRows: step.loopRows }),
        ...(step.maxIterations === undefined ? {} : { maxIterations: step.maxIterations }),
      });
      continue;
    }

    ctx.diagnostics.push(...stepDiagnostics);
    if (stepDiagnostics.length > 0) continue;

    out.push({
      ordinal: step.ordinal,
      kind: "action",
      renderedSentence: step.renderedSentence,
      groupPath: step.groupPath,
      args,
      opKey: step.opKey,
      ...(locators === undefined ? {} : { locators }),
    });
  }

  return out;
}

function resolveElement(
  step: BoundActionStep,
  ctx: ResolveCtx,
  sink: CompileDiagnostic[],
): LocatorSet | undefined {
  const { elementId } = step;
  if (elementId === undefined) return undefined;

  const element = ctx.elements[elementId];
  if (element === undefined) {
    sink.push({
      severity: "error",
      code: "element_not_found",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Element "${elementId}" không có trong snapshot — step tham chiếu element đã xoá hoặc thuộc project khác`,
    });
    return undefined;
  }

  // status=ready mà rỗng locator là snapshot mâu thuẫn: về mặt chạy được thì y hệt pending.
  if (element.status === "pending_locator" || element.locators.length === 0) {
    sink.push({
      severity: "error",
      code: "element_pending_locator",
      caseId: ctx.caseId,
      stepOrdinal: step.ordinal,
      message: `Element "${elementId}" chưa có locator dùng được (status=${element.status}, ${element.locators.length} locator) — chụp locator trước khi chạy`,
    });
    return undefined;
  }

  return { elementId: element.id, elementName: element.name, locators: element.locators };
}

function mergeArgs(
  args: Readonly<Record<string, string>>,
  ctx: ResolveCtx,
  ordinal: number,
  sink: CompileDiagnostic[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(args)) {
    const ref = parseArgRef(value);
    if (ref === undefined) {
      out[key] = value;
      continue;
    }

    switch (ref.kind) {
      case "secret":
        if (!ctx.env.secretNames.includes(ref.name)) {
          sink.push({
            severity: "error",
            code: "secret_ref_unknown",
            caseId: ctx.caseId,
            stepOrdinal: ordinal,
            message: `Secret "${ref.name}" (arg "${key}") không có trong environment — khai báo secret trước khi tham chiếu`,
          });
        }
        out[key] = value; // ref đi thẳng vào plan, giá trị ở lại vault
        break;
      case "data":
        out[key] = ctx.dataRow[ref.name] ?? value;
        break;
      case "env":
        out[key] = ctx.env.vars[ref.name] ?? value;
        break;
    }
  }

  return out;
}

function parseArgRef(value: string): { readonly kind: ArgRefKind; readonly name: string } | undefined {
  const [, kind, name] = ARG_REF.exec(value) ?? [];
  if (name === undefined) return undefined;

  switch (kind) {
    case "secret":
    case "data":
    case "env":
      return { kind, name };
    default:
      return undefined;
  }
}
