/**
 * Phase 6+7 — stamp policy/tenant, then FREEZE (blueprint §4).
 *
 * Phase 6 — stamp: the plan carries everything the worker needs to run WITHOUT asking the
 * control plane again:
 *  - `timeoutSeconds` per chain = `clamp(90 + 12×steps, 180..900)`. A chain is the unit of
 *    job, so the time cap belongs to the chain too: 90s to spin up a context + ~12s/step, a
 *    180s floor so a 1–2 step chain doesn't die from a single cold start, a 900s cap so one
 *    hung case doesn't hold a slot all night.
 *  - `retry: "infra-only"` — an AssertionFailure is NEVER retried (taxonomy §4); only a
 *    RetryableInfraError gets rerun. Stamped into the plan so the worker doesn't decide on its own.
 *  - `screenshots` by lane (§5.2): interactive = every step (a QA is watching live), batch =
 *    a ring buffer that only uploads when the chain FAILS. A per-run override beats the
 *    lane's default.
 *  - `engine` + `baseUrl` + tenant/project: pinned here, never read again at run time.
 *
 * Phase 7 — freeze: payload → canonical JSON → SHA-256 → `contentHash`.
 *  - `canonicalJson` sorts keys RECURSIVELY so the hash depends on CONTENT, not on whatever
 *    key order JS happened to insert into the object. ARRAY order is preserved — that's
 *    execution order, which is semantic.
 *  - An absent optional field ≡ a field holding `undefined` (the `exactOptionalPropertyTypes`
 *    rule): two identical plans must not produce two different hashes because of one explicit
 *    `undefined`.
 *  - No `Date.now()`, no `Math.random()`: same input ⇒ same hash, forever. `node:crypto` is a
 *    pure COMPUTATION (no fs/net/db) so it doesn't break the "compiler is PURE" rule.
 *
 * TODO(M6-storage) zstd: `planFormatVersion = 1` is the RAW, UNCOMPRESSED payload. Compression
 * lives at orchestration's storage/transport layer, not here — and once enabled, it must compress
 * EXACTLY this canonical string, so `contentHash`'s meaning doesn't change. Changing the
 * compression scheme ⇒ bump `planFormatVersion` to 2. The tag says M6 (not M2, which shipped
 * without it) because the work is a storage/transport decision, and the backlog line lives in
 * `testkite/tasks/M6-webhooks-observability-dr.md`.
 */
import { createHash } from "node:crypto";
import type { ResolvedCase, ResolvedStep } from "./phase45-resolve.js";

/** The plan FORMAT version (not the compiler's version): 1 = raw canonical JSON, uncompressed. */
export const PLAN_FORMAT_VERSION = 1;

export const CHAIN_TIMEOUT_BASE_SECONDS = 90;
export const CHAIN_TIMEOUT_PER_STEP_SECONDS = 12;
export const MIN_CHAIN_TIMEOUT_SECONDS = 180;
export const MAX_CHAIN_TIMEOUT_SECONDS = 900;

/** The lane decides screenshot policy + worker kind (§5.2, §5). */
export type RunLane = "interactive" | "batch";

/** `all` = every step; `failure` = only upload when the chain fails; `none` = fully off. */
export type ScreenshotPolicy = "all" | "failure" | "none";

export interface RunPolicy {
  readonly lane: RunLane;
  readonly engine: "chromium-headless-shell";
  /** An AssertionFailure is a verdict, not an incident — only an infra error may be retried. */
  readonly retry: "infra-only";
  readonly screenshots: ScreenshotPolicy;
  readonly baseUrl: string;
}

/** A frozen case = phase 4+5's ResolvedCase, nothing added (everything is already immutable by then). */
export type CasePlan = ResolvedCase;
export type StepPlan = ResolvedStep;

export interface ChainPlan {
  readonly chainKey: string;
  readonly cases: readonly CasePlan[];
  /** The chain's total static step count — the dispatcher computes cost from this, no re-walking the tree. */
  readonly stepCount: number;
  readonly timeoutSeconds: number;
}

export interface RunPlan {
  readonly planFormatVersion: typeof PLAN_FORMAT_VERSION;
  readonly teamId: string;
  readonly projectId: string;
  readonly policy: RunPolicy;
  /** Each chain = prereq + target — the fleet's JOB UNIT. */
  readonly chains: readonly ChainPlan[];
  /** SHA-256 hex of the canonical JSON of the rest of this plan. */
  readonly contentHash: string;
}

/** The payload actually hashed: the whole plan MINUS contentHash itself. */
type PlanPayload = Omit<RunPlan, "contentHash">;

export interface FrozenChain {
  readonly chainKey: string;
  readonly cases: readonly CasePlan[];
}

export interface FreezeInput {
  readonly teamId: string;
  readonly projectId: string;
  readonly baseUrl: string;
  readonly lane: RunLane;
  /** Per-run override; absent ⇒ defaults by lane. */
  readonly screenshots?: ScreenshotPolicy;
  readonly chains: readonly FrozenChain[];
}

export function freezePlan(input: FreezeInput): RunPlan {
  const policy: RunPolicy = {
    lane: input.lane,
    engine: "chromium-headless-shell",
    retry: "infra-only",
    screenshots: input.screenshots ?? defaultScreenshots(input.lane),
    baseUrl: input.baseUrl,
  };

  const chains: readonly ChainPlan[] = input.chains.map((chain) => {
    const stepCount = countSteps(chain.cases);
    return {
      chainKey: chain.chainKey,
      cases: chain.cases,
      stepCount,
      timeoutSeconds: chainTimeoutSeconds(stepCount),
    };
  });

  const payload: PlanPayload = {
    planFormatVersion: PLAN_FORMAT_VERSION,
    teamId: input.teamId,
    projectId: input.projectId,
    policy,
    chains,
  };

  return { ...payload, contentHash: contentHashOf(payload) };
}

function defaultScreenshots(lane: RunLane): ScreenshotPolicy {
  return lane === "interactive" ? "all" : "failure";
}

/**
 * The time cap for ONE chain. A `for`/`while` loop is only counted by the STATIC size of
 * its body (the real iteration count is only known by the worker) — the 900s cap is what
 * bounds that case.
 */
export function chainTimeoutSeconds(stepCount: number): number {
  const raw = CHAIN_TIMEOUT_BASE_SECONDS + CHAIN_TIMEOUT_PER_STEP_SECONDS * stepCount;
  return Math.min(MAX_CHAIN_TIMEOUT_SECONDS, Math.max(MIN_CHAIN_TIMEOUT_SECONDS, raw));
}

/** Counts RECURSIVELY every step node (structural nodes included) across every iteration in the chain. */
export function countSteps(cases: readonly CasePlan[]): number {
  let total = 0;
  for (const kase of cases) total += countStepNodes(kase.steps);
  return total;
}

function countStepNodes(steps: readonly StepPlan[]): number {
  let total = 0;
  for (const step of steps) {
    total += 1;
    if (step.kind !== "action") total += countStepNodes(step.children);
  }
  return total;
}

export function contentHashOf(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted by code unit (recursively), array order preserved,
 * an `undefined` field dropped exactly as if it were absent.
 *
 * Deliberately NOT lenient: hitting something outside JSON (NaN, a function, Date, Map,
 * a class instance…) THROWS rather than silently turning it into `null`/`{}` — a plan
 * hashed wrong is a plan wrong forever, and that kind of bug has no way to be caught later.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined) {
    throw new Error("canonicalJson: the root value is undefined — no payload to hash");
  }
  return encoded;
}

/** `undefined` = "this field disappears" (only valid inside an object). */
function encode(value: unknown): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return undefined;
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJson: a number must be finite, got ${String(value)}`);
      }
      return JSON.stringify(value);
    case "object":
      return encodeObject(value);
    default:
      throw new Error(`canonicalJson: type "${typeof value}" is not JSON — the payload was wrong from the start`);
  }
}

function encodeObject(value: object): string {
  if (Array.isArray(value)) {
    // An undefined array element becomes null (correct JSON semantics): dropping it would shift indexes.
    const items: readonly unknown[] = value;
    return `[${items.map((item) => encode(item) ?? "null").join(",")}]`;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(
      `canonicalJson: only plain objects are accepted — got an instance of "${value.constructor.name}"`,
    );
  }

  const record: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort(byCodeUnit)) {
    const encoded = encode(record[key]);
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}

/** Compares by UTF-16 code unit, NOT by locale — the hash must be identical on every machine. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
