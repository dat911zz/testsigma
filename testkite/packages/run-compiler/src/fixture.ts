/**
 * Đọc fixture golden từ JSON THÔ thành `CompileInput` đã kiểm — hàm PURE (không fs:
 * `golden.test.ts` lo phần đĩa, ở đây chỉ có dữ liệu vào, dữ liệu ra).
 *
 * Vì sao cần parser thay vì `JSON.parse` rồi ép kiểu:
 *  - Fixture là DỮ LIỆU trên đĩa, TypeScript không kiểm được nó. Ép kiểu (`as CompileSnapshot`)
 *    chỉ là lời hứa suông — khoá gõ sai (`verbOpkey`) sẽ IM LẶNG biến fixture "verb hợp lệ"
 *    thành fixture "unknown_verb", rồi golden đóng dấu cái sai đó thành hợp đồng của cả hệ.
 *  - Nên: khoá lạ bị TỪ CHỐI (không bỏ qua), sai kiểu bị từ chối kèm đường dẫn chính xác,
 *    và record theo id phải có khoá TRÙNG id bên trong.
 *  - Fixture cũng phải tự khai nó dương hay âm (`expect` + `expectCodes`): golden runner
 *    so khớp lời khai đó với diagnostics thật, nên một lần `UPDATE_GOLDEN` vô ý không thể
 *    lặng lẽ đổi một fixture âm thành dương.
 *
 * Lỗi ở đây NÉM, không gom: fixture hỏng là lỗi của người viết test, không phải đầu vào của
 * người dùng — nó phải chặn suite lại ngay tại file hỏng, càng ồn càng tốt.
 */
import { COMPILE_ERROR_CODES } from "./index.js";
import type { CompileErrorCode, CompileInput, RunLane, ScreenshotPolicy } from "./index.js";
import type {
  AuthoredCase,
  AuthoredStep,
  CompileSnapshot,
  DataProfileSnapshot,
  DataRow,
  ElementSnapshot,
  EnvSnapshot,
  StepKind,
} from "./snapshot.js";

export interface CompileFixture {
  /** Trùng tên file (không đuôi) — golden runner cưỡng chế. */
  readonly name: string;
  /** Câu mô tả cho người đọc: fixture này giữ hợp đồng NÀO. */
  readonly description: string;
  /** `plan` = compile phải ra plan; `diagnostics` = phải hỏng đúng các code đã khai. */
  readonly expect: "plan" | "diagnostics";
  /** Rỗng khi `expect === "plan"`. */
  readonly expectCodes: readonly CompileErrorCode[];
  readonly input: CompileInput;
}

const STEP_KINDS = ["action", "step_group", "if", "for", "while", "rest"] as const satisfies readonly StepKind[];
const ELEMENT_STATUSES = ["ready", "pending_locator"] as const satisfies readonly ElementSnapshot["status"][];
const LANES = ["interactive", "batch"] as const satisfies readonly RunLane[];
const SCREENSHOT_POLICIES = ["all", "failure", "none"] as const satisfies readonly ScreenshotPolicy[];
const EXPECTATIONS = ["plan", "diagnostics"] as const;

/** Bảo hiểm chiều ngược: thêm `StepKind` mới mà quên khai ở trên ⇒ gãy typecheck, không im lặng. */
type MissingStepKind = Exclude<StepKind, (typeof STEP_KINDS)[number]>;
const _allStepKindsListed: [MissingStepKind] extends [never] ? true : false = true;
void _allStepKindsListed;

/** Vị trí trong file fixture — mọi lỗi đều chỉ được đúng chỗ tác giả phải sửa. */
interface At {
  readonly source: string;
  readonly path: string;
}

export function parseFixture(raw: unknown, source: string): CompileFixture {
  const loc: At = { source, path: "fixture" };
  const rec = asRecord(raw, loc);
  checkKeys(rec, loc, ["name", "description", "expect", "snapshot"], [
    "expectCodes",
    "lane",
    "screenshots",
  ]);

  const expectation = asEnum(rec["expect"], at(loc, "expect"), EXPECTATIONS);
  const codesLoc = at(loc, "expectCodes");
  const expectCodes =
    rec["expectCodes"] === undefined
      ? []
      : asArray(rec["expectCodes"], codesLoc).map((code, i) =>
          asEnum(code, at(codesLoc, i), COMPILE_ERROR_CODES),
        );

  if (expectation === "plan" && expectCodes.length > 0) {
    fail(codesLoc, `fixture expect="plan" thì không được khai expectCodes (đang khai ${expectCodes.length})`);
  }
  if (expectation === "diagnostics" && expectCodes.length === 0) {
    fail(codesLoc, `fixture expect="diagnostics" phải liệt kê ít nhất 1 CompileErrorCode nó chứng minh`);
  }

  const lane = rec["lane"] === undefined ? undefined : asEnum(rec["lane"], at(loc, "lane"), LANES);
  const screenshots =
    rec["screenshots"] === undefined
      ? undefined
      : asEnum(rec["screenshots"], at(loc, "screenshots"), SCREENSHOT_POLICIES);

  return {
    name: asString(rec["name"], at(loc, "name")),
    description: asString(rec["description"], at(loc, "description")),
    expect: expectation,
    expectCodes,
    input: {
      snapshot: parseSnapshot(rec["snapshot"], at(loc, "snapshot")),
      ...(lane === undefined ? {} : { lane }),
      ...(screenshots === undefined ? {} : { screenshots }),
    },
  };
}

function parseSnapshot(value: unknown, loc: At): CompileSnapshot {
  const rec = asRecord(value, loc);
  checkKeys(
    rec,
    loc,
    ["teamId", "projectId", "targetCaseIds", "cases", "elements", "dataProfiles", "env"],
    [],
  );

  return {
    teamId: asString(rec["teamId"], at(loc, "teamId")),
    projectId: asString(rec["projectId"], at(loc, "projectId")),
    targetCaseIds: asStringArray(rec["targetCaseIds"], at(loc, "targetCaseIds")),
    cases: parseRecordById(rec["cases"], at(loc, "cases"), parseCase),
    elements: parseRecordById(rec["elements"], at(loc, "elements"), parseElement),
    dataProfiles: parseRecordById(rec["dataProfiles"], at(loc, "dataProfiles"), parseDataProfile),
    env: parseEnv(rec["env"], at(loc, "env")),
  };
}

function parseCase(value: unknown, loc: At): AuthoredCase {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["id", "revisionId", "name", "isStepGroup", "steps"], [
    "prereqCaseId",
    "dataProfileId",
  ]);

  const stepsLoc = at(loc, "steps");
  return {
    id: asString(rec["id"], at(loc, "id")),
    revisionId: asString(rec["revisionId"], at(loc, "revisionId")),
    name: asString(rec["name"], at(loc, "name")),
    isStepGroup: asBoolean(rec["isStepGroup"], at(loc, "isStepGroup")),
    steps: asArray(rec["steps"], stepsLoc).map((step, i) => parseStep(step, at(stepsLoc, i))),
    ...(rec["prereqCaseId"] === undefined
      ? {}
      : { prereqCaseId: asString(rec["prereqCaseId"], at(loc, "prereqCaseId")) }),
    ...(rec["dataProfileId"] === undefined
      ? {}
      : { dataProfileId: asString(rec["dataProfileId"], at(loc, "dataProfileId")) }),
  };
}

function parseStep(value: unknown, loc: At): AuthoredStep {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["ordinal", "kind", "renderedSentence"], [
    "verbOpKey",
    "args",
    "elementId",
    "stepGroupCaseId",
    "conditionExpected",
    "loopDataProfileId",
    "maxIterations",
    "children",
  ]);

  const childrenLoc = at(loc, "children");
  return {
    ordinal: asNumber(rec["ordinal"], at(loc, "ordinal")),
    kind: asEnum(rec["kind"], at(loc, "kind"), STEP_KINDS),
    renderedSentence: asString(rec["renderedSentence"], at(loc, "renderedSentence")),
    ...(rec["verbOpKey"] === undefined
      ? {}
      : { verbOpKey: asString(rec["verbOpKey"], at(loc, "verbOpKey")) }),
    ...(rec["args"] === undefined ? {} : { args: asStringRecord(rec["args"], at(loc, "args")) }),
    ...(rec["elementId"] === undefined
      ? {}
      : { elementId: asString(rec["elementId"], at(loc, "elementId")) }),
    ...(rec["stepGroupCaseId"] === undefined
      ? {}
      : { stepGroupCaseId: asString(rec["stepGroupCaseId"], at(loc, "stepGroupCaseId")) }),
    ...(rec["conditionExpected"] === undefined
      ? {}
      : { conditionExpected: asStringArray(rec["conditionExpected"], at(loc, "conditionExpected")) }),
    ...(rec["loopDataProfileId"] === undefined
      ? {}
      : { loopDataProfileId: asString(rec["loopDataProfileId"], at(loc, "loopDataProfileId")) }),
    ...(rec["maxIterations"] === undefined
      ? {}
      : { maxIterations: asNumber(rec["maxIterations"], at(loc, "maxIterations")) }),
    ...(rec["children"] === undefined
      ? {}
      : {
          children: asArray(rec["children"], childrenLoc).map((child, i) =>
            parseStep(child, at(childrenLoc, i)),
          ),
        }),
  };
}

function parseElement(value: unknown, loc: At): ElementSnapshot {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["id", "name", "status", "locators"], []);

  const locatorsLoc = at(loc, "locators");
  return {
    id: asString(rec["id"], at(loc, "id")),
    name: asString(rec["name"], at(loc, "name")),
    status: asEnum(rec["status"], at(loc, "status"), ELEMENT_STATUSES),
    locators: asArray(rec["locators"], locatorsLoc).map((locator, i) => {
      const itemLoc = at(locatorsLoc, i);
      const item = asRecord(locator, itemLoc);
      checkKeys(item, itemLoc, ["kind", "value"], []);
      return {
        kind: asString(item["kind"], at(itemLoc, "kind")),
        value: asString(item["value"], at(itemLoc, "value")),
      };
    }),
  };
}

function parseDataProfile(value: unknown, loc: At): DataProfileSnapshot {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["id", "rows"], []);

  const rowsLoc = at(loc, "rows");
  return {
    id: asString(rec["id"], at(loc, "id")),
    rows: asArray(rec["rows"], rowsLoc).map((row, i) => parseDataRow(row, at(rowsLoc, i))),
  };
}

function parseDataRow(value: unknown, loc: At): DataRow {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["label", "expectedToFail", "values"], []);

  return {
    label: asString(rec["label"], at(loc, "label")),
    expectedToFail: asBoolean(rec["expectedToFail"], at(loc, "expectedToFail")),
    values: asStringRecord(rec["values"], at(loc, "values")),
  };
}

function parseEnv(value: unknown, loc: At): EnvSnapshot {
  const rec = asRecord(value, loc);
  checkKeys(rec, loc, ["baseUrl", "vars", "secretNames"], []);

  return {
    baseUrl: asString(rec["baseUrl"], at(loc, "baseUrl")),
    vars: asStringRecord(rec["vars"], at(loc, "vars")),
    secretNames: asStringArray(rec["secretNames"], at(loc, "secretNames")),
  };
}

/**
 * Record đánh index theo id. Khoá PHẢI trùng `id` bên trong: lệch nhau là bom hẹn giờ —
 * phase 1 tra `cases[id]` theo khoá, còn diagnostic in ra `id`, nên một fixture lệch khoá
 * sẽ mô tả một tình huống khác hẳn tình huống tác giả tưởng mình đang viết.
 */
function parseRecordById<T extends { readonly id: string }>(
  value: unknown,
  loc: At,
  parse: (item: unknown, itemLoc: At) => T,
): Readonly<Record<string, T>> {
  const rec = asRecord(value, loc);
  const out: Record<string, T> = {};

  for (const key of Object.keys(rec)) {
    const itemLoc = at(loc, key);
    const item = parse(rec[key], itemLoc);
    if (item.id !== key) fail(itemLoc, `khoá record "${key}" khác id bên trong "${item.id}"`);
    out[key] = item;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Nguyên thuỷ
// ---------------------------------------------------------------------------

function at(parent: At, key: string | number): At {
  const path = typeof key === "number" ? `${parent.path}[${key}]` : `${parent.path}.${key}`;
  return { source: parent.source, path };
}

function fail(loc: At, detail: string): never {
  throw new Error(`${loc.source}: ${loc.path} — ${detail}`);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function asRecord(value: unknown, loc: At): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(loc, `cần object, gặp ${kindOf(value)}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Cưỡng chế BỘ KHOÁ đúng: thiếu khoá bắt buộc là lỗi, mà khoá LẠ cũng là lỗi. Khoan dung với
 * khoá lạ nghĩa là chấp nhận `verbOpkey` trôi qua thành fixture nói dối — dạng sai tệ nhất,
 * vì golden sẽ đóng dấu nó thành hợp đồng.
 */
function checkKeys(
  rec: Readonly<Record<string, unknown>>,
  loc: At,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of required) {
    if (rec[key] === undefined) fail(at(loc, key), "thiếu field bắt buộc");
  }

  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(rec)) {
    if (!known.has(key)) {
      fail(loc, `khoá lạ "${key}" — hợp lệ: [${[...known].join(" | ")}]`);
    }
  }
}

function asString(value: unknown, loc: At): string {
  if (typeof value !== "string") fail(loc, `cần string, gặp ${kindOf(value)}`);
  return value;
}

function asNumber(value: unknown, loc: At): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(loc, `cần number hữu hạn, gặp ${kindOf(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, loc: At): boolean {
  if (typeof value !== "boolean") fail(loc, `cần boolean, gặp ${kindOf(value)}`);
  return value;
}

function asArray(value: unknown, loc: At): readonly unknown[] {
  if (!Array.isArray(value)) fail(loc, `cần array, gặp ${kindOf(value)}`);
  return value;
}

function asStringArray(value: unknown, loc: At): readonly string[] {
  return asArray(value, loc).map((item, i) => asString(item, at(loc, i)));
}

function asStringRecord(value: unknown, loc: At): Readonly<Record<string, string>> {
  const rec = asRecord(value, loc);
  const out: Record<string, string> = {};
  for (const key of Object.keys(rec)) out[key] = asString(rec[key], at(loc, key));
  return out;
}

function asEnum<T extends string>(value: unknown, loc: At, allowed: readonly T[]): T {
  const text = asString(value, loc);
  const found = allowed.find((candidate) => candidate === text);
  if (found === undefined) fail(loc, `cần một trong [${allowed.join(" | ")}], gặp "${text}"`);
  return found;
}
