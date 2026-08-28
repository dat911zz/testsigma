/**
 * Dựng `CompileSnapshot` — đầu vào DUY NHẤT của @testkite/run-compiler.
 * Compiler là hàm THUẦN, không I/O: mọi thứ nó cần phải được fetch sẵn ở đây.
 *
 * RANH GIỚI MODULE (blueprint §4 DAG một chiều):
 *   - elements/testdata đứng TRƯỚC authoring ⇒ được phép gọi, nhưng M2 chưa có
 *     hai module đó nên chúng vào qua CỔNG TIÊM (SnapshotDeps). M4 nối facade thật.
 *   - planning (pln_environments) đứng SAU authoring ⇒ CẤM import. Vì vậy `env` là
 *     THAM SỐ do orchestration (phase 0) nạp và truyền xuống.
 */
import type {
  AuthoredCaseDto,
  AuthoredStepDto,
  CompileSnapshotDto,
  DataProfileDto,
  ElementDto,
  EnvDto,
} from "@testkite/contract";
import type { TenantContext, TkTx } from "../kernel/index.js";
import { CaseRepo } from "./db/case-repo.js";
import { RevisionRepo } from "./db/revision-repo.js";
import { CaseNotFoundError, CaseStateError } from "./errors.js";
import type { RevisionPayload, RevisionStep } from "./revision/payload.js";

export type SnapshotPin = "ready" | "latest";

export interface SnapshotDeps {
  readonly loadElements: (ids: readonly string[]) => Promise<Record<string, ElementDto>>;
  readonly loadDataProfiles: (ids: readonly string[]) => Promise<Record<string, DataProfileDto>>;
  readonly env: EnvDto;
}

export interface SnapshotInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly pin: SnapshotPin;
}

/** Trần cứng khi đóng bao prereq + step group. Vượt = dữ liệu sai, không phải case to. */
export const MAX_SNAPSHOT_CASES = 200;

/** Dựng lại CÂY step từ danh sách phẳng (parentId + after) và đánh lại ordinal từ 1. */
function toAuthoredSteps(steps: readonly RevisionStep[], parentId: string | null): AuthoredStepDto[] {
  const siblings = steps.filter((s) => s.parentId === parentId);
  // `after` là danh sách liên kết đơn: bắt đầu từ phần tử có after = null.
  const byAfter = new Map<string | null, RevisionStep>();
  for (const s of siblings) byAfter.set(s.after, s);

  const ordered: RevisionStep[] = [];
  let cursor = byAfter.get(null);
  const guard = siblings.length + 1;
  while (cursor !== undefined && ordered.length < guard) {
    ordered.push(cursor);
    cursor = byAfter.get(cursor.id);
  }
  // Payload hỏng (vòng lặp / mất mắt xích): giữ phần dựng được, nối phần còn lại.
  for (const s of siblings) if (!ordered.includes(s)) ordered.push(s);

  return ordered.map((s, i): AuthoredStepDto => {
    const ordinal = i + 1;
    switch (s.kind) {
      case "action":
        return {
          kind: "action",
          ordinal,
          renderedSentence: s.renderedSentence,
          verbOpKey: s.verbOpKey ?? "",
          ...(s.args === undefined ? {} : { args: s.args }),
          ...(s.elementId === undefined ? {} : { elementId: s.elementId }),
        };
      case "step_group":
        return {
          kind: "step_group",
          ordinal,
          renderedSentence: s.renderedSentence,
          stepGroupCaseId: s.stepGroupCaseId ?? "",
        };
      case "if":
        return {
          kind: "if",
          ordinal,
          renderedSentence: s.renderedSentence,
          conditionExpected: [...(s.conditionExpected ?? [])],
          children: toAuthoredSteps(steps, s.id),
        };
      case "for":
        return {
          kind: "for",
          ordinal,
          renderedSentence: s.renderedSentence,
          loopDataProfileId: s.loop?.dataProfileId ?? "",
          children: toAuthoredSteps(steps, s.id),
        };
      case "while":
        return {
          kind: "while",
          ordinal,
          renderedSentence: s.renderedSentence,
          ...(s.loop?.maxIterations === undefined ? {} : { maxIterations: s.loop.maxIterations }),
          children: toAuthoredSteps(steps, s.id),
        };
      case "rest":
        return {
          kind: "rest",
          ordinal,
          renderedSentence: s.renderedSentence,
          // REST của DB (method/url/headers/body/storeAs) dẹt thành `args` của hợp
          // đồng — headers đi dạng JSON string vì args là Record<string,string>.
          args: {
            ...(s.rest === undefined
              ? {}
              : {
                  method: s.rest.method,
                  url: s.rest.url,
                  ...(s.rest.headers === undefined ? {} : { headers: JSON.stringify(s.rest.headers) }),
                  ...(s.rest.body === undefined ? {} : { body: s.rest.body }),
                  ...(s.rest.storeAs === undefined ? {} : { store: s.rest.storeAs }),
                }),
          },
        };
    }
  });
}

export function revisionPayloadToAuthoredCase(
  caseId: string,
  revisionId: string,
  payload: RevisionPayload,
): AuthoredCaseDto {
  return {
    id: caseId,
    revisionId,
    name: payload.case.name,
    isStepGroup: payload.case.isStepGroup,
    ...(payload.case.prereqCaseId === undefined ? {} : { prereqCaseId: payload.case.prereqCaseId }),
    ...(payload.case.dataProfileId === undefined ? {} : { dataProfileId: payload.case.dataProfileId }),
    steps: toAuthoredSteps(payload.steps, null),
  };
}

export async function buildCompileSnapshot(
  tx: TkTx,
  ctx: TenantContext,
  input: SnapshotInput,
  deps: SnapshotDeps,
): Promise<CompileSnapshotDto> {
  const cases = new CaseRepo(tx, ctx);
  const revisions = new RevisionRepo(tx, ctx);

  const collected: Record<string, AuthoredCaseDto> = {};
  const elementIds = new Set<string>();
  const dataProfileIds = new Set<string>();
  const queue = [...input.targetCaseIds];

  while (queue.length > 0) {
    const caseId = queue.shift();
    if (caseId === undefined || caseId in collected) continue;
    if (Object.keys(collected).length >= MAX_SNAPSHOT_CASES) {
      throw new CaseStateError(
        `Chuỗi case vượt trần ${MAX_SNAPSHOT_CASES} — nghi đồ thị prereq/step group dựng sai`,
      );
    }
    const row = await cases.findById(caseId);
    // RLS đã lọc tenant khác ⇒ 404, không bao giờ 403 (blueprint §3 L3).
    if (row === undefined) throw new CaseNotFoundError(caseId);

    const revisionId = input.pin === "ready" ? row.readyRevisionId : row.latestRevisionId;
    if (revisionId === null) {
      throw new CaseStateError(
        input.pin === "ready"
          ? `Case ${caseId} chưa có bản ready — promote nó trước khi chạy theo lịch/CI`
          : `Case ${caseId} chưa có revision nào`,
      );
    }
    const payload = await revisions.loadPayload(revisionId);
    const authored = revisionPayloadToAuthoredCase(caseId, revisionId, payload);
    collected[caseId] = authored;

    if (authored.prereqCaseId !== undefined) queue.push(authored.prereqCaseId);
    if (authored.dataProfileId !== undefined) dataProfileIds.add(authored.dataProfileId);
    for (const step of payload.steps) {
      if (step.elementId !== undefined) elementIds.add(step.elementId);
      if (step.stepGroupCaseId !== undefined) queue.push(step.stepGroupCaseId);
      if (step.loop?.dataProfileId !== undefined) dataProfileIds.add(step.loop.dataProfileId);
    }
  }

  // Gọi ĐÚNG MỘT lần cho mỗi cổng: N+1 query ở phase 0 là đúng lớp lỗi hệ cũ chết vì nó.
  const elements = await deps.loadElements([...elementIds].sort());
  const dataProfiles = await deps.loadDataProfiles([...dataProfileIds].sort());

  return {
    teamId: ctx.teamId,
    projectId: input.projectId,
    targetCaseIds: [...input.targetCaseIds],
    cases: collected,
    elements,
    dataProfiles,
    env: deps.env,
  };
}
