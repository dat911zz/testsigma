/**
 * Reads a golden fixture from RAW JSON into a checked `CompileInput` — a PURE function
 * (no fs: `golden.test.ts` handles the disk side, here it's just data in, data out).
 *
 * Why a parser is needed instead of `JSON.parse` plus a type cast:
 *  - A fixture is DATA on disk; TypeScript cannot check it. A cast (`as CompileSnapshot`)
 *    is just an empty promise — a mistyped key (`verbOpkey`) would SILENTLY turn a
 *    "verb is valid" fixture into an "unknown_verb" fixture, and golden would then stamp
 *    that mistake as the whole system's contract.
 *  - So: an unknown key is REJECTED (never skipped), a wrong type is rejected with the
 *    exact path, and a record keyed by id must have a key that MATCHES its internal id.
 *  - A fixture must also declare whether it's positive or negative (`expect` + `expectCodes`):
 *    the golden runner checks that declaration against the real diagnostics, so an
 *    accidental `UPDATE_GOLDEN` can't silently turn a negative fixture into a positive one.
 *
 * Errors here THROW, they don't collect: a broken fixture is the test author's bug, not
 * user input — it must stop the suite right at the broken file, as loudly as possible.
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
  /** Must match the file name (no extension) — enforced by the golden runner. */
  readonly name: string;
  /** A description for readers: WHICH contract this fixture holds. */
  readonly description: string;
  /** `plan` = compiling must produce a plan; `diagnostics` = must fail with exactly the declared codes. */
  readonly expect: "plan" | "diagnostics";
  /** Empty when `expect === "plan"`. */
  readonly expectCodes: readonly CompileErrorCode[];
  readonly input: CompileInput;
}

const STEP_KINDS = ["action", "step_group", "if", "for", "while", "rest"] as const satisfies readonly StepKind[];
const ELEMENT_STATUSES = ["ready", "pending_locator"] as const satisfies readonly ElementSnapshot["status"][];
const LANES = ["interactive", "batch"] as const satisfies readonly RunLane[];
const SCREENSHOT_POLICIES = ["all", "failure", "none"] as const satisfies readonly ScreenshotPolicy[];
const EXPECTATIONS = ["plan", "diagnostics"] as const;

/** Insurance in the reverse direction: adding a new `StepKind` and forgetting to list it here ⇒ breaks typecheck, not silent. */
type MissingStepKind = Exclude<StepKind, (typeof STEP_KINDS)[number]>;
const _allStepKindsListed: [MissingStepKind] extends [never] ? true : false = true;
void _allStepKindsListed;

/** A location within the fixture file — every error points to exactly where the author must fix it. */
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
    fail(codesLoc, `a fixture with expect="plan" must not declare expectCodes (found ${expectCodes.length})`);
  }
  if (expectation === "diagnostics" && expectCodes.length === 0) {
    fail(codesLoc, `a fixture with expect="diagnostics" must list at least 1 CompileErrorCode it proves`);
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
 * A record indexed by id. The key MUST match the internal `id`: a mismatch is a time
 * bomb — phase 1 looks up `cases[id]` by key, while diagnostics print out `id`, so a
 * fixture with a mismatched key would describe a completely different situation than
 * the one the author thinks they're writing.
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
    if (item.id !== key) fail(itemLoc, `record key "${key}" differs from its internal id "${item.id}"`);
    out[key] = item;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Primitives
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
    fail(loc, `expected an object, got ${kindOf(value)}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Enforces the correct KEY SET: a missing required key is an error, and so is an
 * unknown key. Being lenient about unknown keys would mean letting `verbOpkey` slip
 * through as a lying fixture — the worst kind of wrong, since golden would then stamp
 * it as the contract.
 */
function checkKeys(
  rec: Readonly<Record<string, unknown>>,
  loc: At,
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const key of required) {
    if (rec[key] === undefined) fail(at(loc, key), "missing required field");
  }

  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(rec)) {
    if (!known.has(key)) {
      fail(loc, `unknown key "${key}" — valid: [${[...known].join(" | ")}]`);
    }
  }
}

function asString(value: unknown, loc: At): string {
  if (typeof value !== "string") fail(loc, `expected a string, got ${kindOf(value)}`);
  return value;
}

function asNumber(value: unknown, loc: At): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(loc, `expected a finite number, got ${kindOf(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, loc: At): boolean {
  if (typeof value !== "boolean") fail(loc, `expected a boolean, got ${kindOf(value)}`);
  return value;
}

function asArray(value: unknown, loc: At): readonly unknown[] {
  if (!Array.isArray(value)) fail(loc, `expected an array, got ${kindOf(value)}`);
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
  if (found === undefined) fail(loc, `expected one of [${allowed.join(" | ")}], got "${text}"`);
  return found;
}
