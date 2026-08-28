/**
 * Cầu nối giữa hình dạng API (cây step lồng nhau, không ordinal) và hình dạng DB
 * (bảng phẳng có parent_step_id + ordinal) — và giữa DB với payload revision
 * (phẳng, vị trí bằng `after`). THUẦN: mọi thứ bất định (id mới) được tiêm vào.
 */
import type { StepInputDto, StepKindDto } from "@testkite/contract";
import type { RevisionCase, RevisionPayload, RevisionStep } from "./revision/payload.js";

export interface StepRow {
  readonly id: string;
  readonly caseId: string;
  readonly parentStepId: string | null;
  readonly ordinal: number;
  readonly kind: StepKindDto;
  readonly renderedSentence: string;
  readonly verbOpKey: string | null;
  readonly elementId: string | null;
  readonly args: Record<string, string> | null;
  readonly stepGroupCaseId: string | null;
  readonly conditionExpected: string[] | null;
}

export interface LoopRow {
  readonly stepId: string;
  readonly dataProfileId: string | null;
  readonly maxIterations: number | null;
}

export interface RestRow {
  readonly stepId: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string> | null;
  readonly body: string | null;
  readonly storeAs: string | null;
}

export interface FlattenInput {
  readonly caseId: string;
  readonly steps: readonly StepInputDto[];
  /** id step ĐANG thuộc case này — chỉ những id trong tập này mới được tái dùng. */
  readonly existingIds: ReadonlySet<string>;
  readonly newId: () => string;
}

export interface FlattenResult {
  readonly steps: StepRow[];
  readonly loops: LoopRow[];
  readonly rests: RestRow[];
}

export function flattenStepInputs(input: FlattenInput): FlattenResult {
  const steps: StepRow[] = [];
  const loops: LoopRow[] = [];
  const rests: RestRow[] = [];
  const used = new Set<string>();

  const resolveId = (candidate: string | undefined): string => {
    // Id lạ (của case khác / tenant khác / bịa) KHÔNG được tái dùng: nó vừa là lỗ
    // tenant vừa làm diff nói dối về danh tính step.
    if (candidate !== undefined && input.existingIds.has(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    return input.newId();
  };

  const walk = (nodes: readonly StepInputDto[], parentStepId: string | null): void => {
    let ordinal = 0;
    for (const node of nodes) {
      ordinal += 1;
      const id = resolveId(node.id);
      const base = {
        id,
        caseId: input.caseId,
        parentStepId,
        ordinal,
        kind: node.kind,
        renderedSentence: node.renderedSentence,
        verbOpKey: null,
        elementId: null,
        args: null,
        stepGroupCaseId: null,
        conditionExpected: null,
      } satisfies StepRow;

      switch (node.kind) {
        case "action":
          steps.push({
            ...base,
            verbOpKey: node.verbOpKey,
            elementId: node.elementId ?? null,
            args: node.args ?? null,
          });
          break;
        case "step_group":
          steps.push({ ...base, stepGroupCaseId: node.stepGroupCaseId });
          break;
        case "if":
          steps.push({ ...base, conditionExpected: [...node.conditionExpected] });
          walk(node.children, id);
          break;
        case "for":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: node.loopDataProfileId, maxIterations: null });
          walk(node.children, id);
          break;
        case "while":
          steps.push(base);
          loops.push({ stepId: id, dataProfileId: null, maxIterations: node.maxIterations ?? null });
          walk(node.children, id);
          break;
        case "rest":
          steps.push(base);
          rests.push({
            stepId: id,
            method: node.method,
            url: node.url,
            headers: node.headers ?? null,
            body: node.body ?? null,
            storeAs: node.storeAs ?? null,
          });
          break;
      }
    }
  };

  walk(input.steps, null);
  return { steps, loops, rests };
}

export interface BuildPayloadInput {
  readonly case: RevisionCase;
  readonly steps: readonly StepRow[];
  readonly loops: readonly LoopRow[];
  readonly rests: readonly RestRow[];
}

/**
 * Dựng payload revision. Hai luật:
 *   1. Vị trí = `after` (id anh liền trước cùng cha), KHÔNG phải ordinal — xem
 *      diff.ts để biết vì sao (spike đo nhiễu 2026-08-28).
 *   2. Field không có giá trị thì BỎ HẲN khỏi object, không set null: hash canonical
 *      phải chỉ phụ thuộc dữ liệu, không phụ thuộc cách dựng object.
 *
 * KHÔNG sắp xếp lại `input.steps`: nó đã theo thứ tự duyệt trước từ
 * `flattenStepInputs`, và trong mỗi nhóm anh em thì ordinal tăng dần — nên "anh
 * liền trước" chính là step gần nhất có cùng cha. Sắp lại theo ordinal TOÀN CỤC sẽ
 * trộn lẫn các nhóm anh em và làm hỏng `after` của step con.
 */
export function buildRevisionPayload(input: BuildPayloadInput): RevisionPayload {
  const loopByStep = new Map(input.loops.map((l) => [l.stepId, l]));
  const restByStep = new Map(input.rests.map((r) => [r.stepId, r]));
  const lastSiblingOf = new Map<string | null, string | null>();

  const steps: RevisionStep[] = [];
  for (const row of input.steps) {
    const after = lastSiblingOf.get(row.parentStepId) ?? null;
    lastSiblingOf.set(row.parentStepId, row.id);
    const loop = loopByStep.get(row.id);
    const rest = restByStep.get(row.id);
    steps.push({
      id: row.id,
      kind: row.kind,
      parentId: row.parentStepId,
      after,
      renderedSentence: row.renderedSentence,
      ...(row.verbOpKey === null ? {} : { verbOpKey: row.verbOpKey }),
      ...(row.elementId === null ? {} : { elementId: row.elementId }),
      ...(row.args === null ? {} : { args: row.args }),
      ...(row.stepGroupCaseId === null ? {} : { stepGroupCaseId: row.stepGroupCaseId }),
      ...(row.conditionExpected === null ? {} : { conditionExpected: row.conditionExpected }),
      ...(loop === undefined
        ? {}
        : {
            loop: {
              ...(loop.dataProfileId === null ? {} : { dataProfileId: loop.dataProfileId }),
              ...(loop.maxIterations === null ? {} : { maxIterations: loop.maxIterations }),
            },
          }),
      ...(rest === undefined
        ? {}
        : {
            rest: {
              method: rest.method,
              url: rest.url,
              ...(rest.headers === null ? {} : { headers: rest.headers }),
              ...(rest.body === null ? {} : { body: rest.body }),
              ...(rest.storeAs === null ? {} : { storeAs: rest.storeAs }),
            },
          }),
    });
  }
  return { case: input.case, steps };
}
