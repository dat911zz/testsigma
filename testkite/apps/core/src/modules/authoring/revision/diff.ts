/**
 * Diff 3 chiều cho payload revision. THUẦN — không I/O, không Date.now().
 *
 * Vì sao TỰ VIẾT thay vì lấy thư viện (khảo sát 2026-08-28):
 *   - Không thư viện npm nào cho diff 3 chiều dạng BÁO CÁO; `json-diff3` (thư viện
 *     merge 3 chiều duy nhất) băm phần tử mảng bằng String(obj) nên ném cứng
 *     "Duplicate array key '[object Object]'" trên đúng hình dạng steps của ta.
 *   - Mọi thư viện 2 chiều (jsondiffpatch, rfc6902, fast-json-patch, deep-object-diff)
 *     báo 4 thay đổi cho 1 lần chèn step; phần chuẩn hoá triệt tiêu nhiễu vẫn phải
 *     tự làm, sau đó thư viện chỉ còn làm vòng for.
 *   - Body 409 phải là DTO có zod schema (gate drift OpenAPI) — định dạng delta
 *     ma thuật của jsondiffpatch không diễn đạt được thành schema tử tế.
 */
import type { CaseChangeDto, ThreeWayDiffDto } from "@testkite/contract";
import { canonicalJson } from "./canonical.js";
import type { RevisionPayload } from "./payload.js";

export interface FlatRevision {
  /** path -> JSON canonical của giá trị. Ví dụ "/name" -> "\"Checkout\"". */
  readonly scalars: ReadonlyMap<string, string>;
  /** stepId -> (field -> JSON canonical). */
  readonly steps: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const CASE_FIELDS = ["name", "isStepGroup", "prereqCaseId", "dataProfileId"] as const;
const STEP_FIELDS = [
  "kind",
  "parentId",
  "after",
  "renderedSentence",
  "verbOpKey",
  "elementId",
  "args",
  "stepGroupCaseId",
  "conditionExpected",
  "loop",
  "rest",
] as const;

export function flattenRevision(payload: RevisionPayload): FlatRevision {
  const scalars = new Map<string, string>();
  for (const field of CASE_FIELDS) {
    const value = payload.case[field];
    if (value === undefined) continue;
    scalars.set(`/${field}`, canonicalJson(value));
  }
  const steps = new Map<string, ReadonlyMap<string, string>>();
  for (const step of payload.steps) {
    const fields = new Map<string, string>();
    for (const field of STEP_FIELDS) {
      const value = step[field];
      if (value === undefined) continue;
      fields.set(field, canonicalJson(value));
    }
    steps.set(step.id, fields);
  }
  return { scalars, steps };
}

/** Chỉ dùng cho `base`/`value` của DTO — trả về giá trị đã parse, không phải chuỗi JSON. */
function parse(json: string | undefined): unknown {
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}

function change(path: string, kind: CaseChangeDto["kind"], base?: string, value?: string): CaseChangeDto {
  const out: CaseChangeDto = { path, kind };
  const b = parse(base);
  const v = parse(value);
  // exactOptionalPropertyTypes: gán undefined tường minh là lỗi kiểu — chỉ gán khi có.
  return {
    ...out,
    ...(b === undefined ? {} : { base: b }),
    ...(v === undefined ? {} : { value: v }),
  };
}

/** So hai bản phẳng. Thêm/xoá báo ở CẤP STEP; sửa báo ở cấp FIELD. */
export function diffFlat(a: FlatRevision, b: FlatRevision): CaseChangeDto[] {
  const out: CaseChangeDto[] = [];

  for (const path of new Set([...a.scalars.keys(), ...b.scalars.keys()])) {
    const x = a.scalars.get(path);
    const y = b.scalars.get(path);
    if (x === y) continue;
    if (x === undefined) out.push(change(path, "added", undefined, y));
    else if (y === undefined) out.push(change(path, "removed", x, undefined));
    else out.push(change(path, "modified", x, y));
  }

  for (const id of new Set([...a.steps.keys(), ...b.steps.keys()])) {
    const x = a.steps.get(id);
    const y = b.steps.get(id);
    if (x !== undefined && y === undefined) {
      out.push({ path: `/steps/${id}`, kind: "removed", base: rebuild(x) });
      continue;
    }
    if (x === undefined && y !== undefined) {
      out.push({ path: `/steps/${id}`, kind: "added", value: rebuild(y, id) });
      continue;
    }
    if (x === undefined || y === undefined) continue;
    for (const field of new Set([...x.keys(), ...y.keys()])) {
      const fx = x.get(field);
      const fy = y.get(field);
      if (fx === fy) continue;
      const path = `/steps/${id}/${field}`;
      if (fx === undefined) out.push(change(path, "added", undefined, fy));
      else if (fy === undefined) out.push(change(path, "removed", fx, undefined));
      else out.push(change(path, "modified", fx, fy));
    }
  }

  // Thứ tự ổn định: body 409 phải giống nhau giữa hai lần chạy (test + client cache).
  return out.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
}

/** Dựng lại object step từ bản phẳng để đưa vào `base`/`value` của mục added/removed. */
function rebuild(fields: ReadonlyMap<string, string>, id?: string): unknown {
  const out: Record<string, unknown> = {};
  if (id !== undefined) out["id"] = id;
  for (const [k, v] of fields) out[k] = JSON.parse(v) as unknown;
  return out;
}

export interface ThreeWayDiffInput {
  readonly base: RevisionPayload;
  readonly mine: RevisionPayload;
  readonly theirs: RevisionPayload;
  readonly baseVersion: number;
  readonly baseRevisionId: string;
  readonly currentVersion: number;
  readonly currentRevisionId: string;
}

/**
 * Conflict = path bị CẢ HAI nhánh chạm tới VÀ đi tới hai giá trị khác nhau.
 * Hai bên sửa giống hệt nhau thì không có gì phải quyết ⇒ không tính conflict.
 * Xoá một bên + sửa bên kia rơi vào cùng path cấp step `/steps/<id>` ở nhánh xoá và
 * path cấp field ở nhánh sửa — nên so cả hai chiều bằng tiền tố.
 */
export function threeWayDiff(input: ThreeWayDiffInput): ThreeWayDiffDto {
  const base = flattenRevision(input.base);
  const mine = diffFlat(base, flattenRevision(input.mine));
  const theirs = diffFlat(base, flattenRevision(input.theirs));

  const theirsByPath = new Map(theirs.map((c) => [c.path, c]));
  const conflicts: string[] = [];
  for (const m of mine) {
    const t = theirsByPath.get(m.path);
    if (t !== undefined) {
      if (canonicalJson(m.value) !== canonicalJson(t.value)) conflicts.push(m.path);
      continue;
    }
    // Nhánh này xoá cả step, nhánh kia sửa field bên trong nó (hoặc ngược lại).
    if (m.kind === "removed" && theirs.some((c) => c.path.startsWith(`${m.path}/`))) {
      conflicts.push(m.path);
    }
  }
  for (const t of theirs) {
    if (t.kind !== "removed") continue;
    if (conflicts.includes(t.path)) continue;
    if (mine.some((c) => c.path.startsWith(`${t.path}/`))) conflicts.push(t.path);
  }

  return {
    baseVersion: input.baseVersion,
    baseRevisionId: input.baseRevisionId,
    currentVersion: input.currentVersion,
    currentRevisionId: input.currentRevisionId,
    mine,
    theirs,
    conflicts: conflicts.sort(),
  };
}
