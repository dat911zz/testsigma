/**
 * Phase 6+7 — stamp policy/tenant, rồi FREEZE (blueprint §4).
 *
 * Phase 6 — stamp: plan mang theo mọi thứ worker cần để chạy mà KHÔNG hỏi lại control plane:
 *  - `timeoutSeconds` per chain = `clamp(90 + 12×steps, 180..900)`. Chain là đơn vị job, nên
 *    trần thời gian cũng thuộc về chain: 90s dựng context + ~12s/step, sàn 180s để chain 1–2
 *    step không chết vì một lần cold start, trần 900s để một case treo không giữ slot cả đêm.
 *  - `retry: "infra-only"` — AssertionFailure KHÔNG BAO GIỜ retry (taxonomy §4); chỉ
 *    RetryableInfraError mới được chạy lại. Đóng dấu vào plan để worker không tự quyết.
 *  - `screenshots` theo lane (§5.2): interactive = mọi step (QA đang ngồi xem), batch =
 *    ring-buffer chỉ upload khi chain FAIL. Per-run override thắng mặc định của lane.
 *  - `engine` + `baseUrl` + tenant/project: ghim tại đây, không đọc lại lúc chạy.
 *
 * Phase 7 — freeze: payload → canonical JSON → SHA-256 → `contentHash`.
 *  - `canonicalJson` sort key ĐỆ QUY nên hash phụ thuộc NỘI DUNG, không phụ thuộc thứ tự key
 *    mà JS tình cờ chèn vào object. Thứ tự MẢNG thì giữ nguyên — đó là thứ tự chạy, là ngữ nghĩa.
 *  - Field optional vắng mặt ≡ field mang `undefined` (luật `exactOptionalPropertyTypes`):
 *    hai plan giống nhau không được ra hai hash khác nhau vì một `undefined` tường minh.
 *  - Không `Date.now()`, không `Math.random()`: cùng input ⇒ cùng hash, mãi mãi. `node:crypto`
 *    là TÍNH TOÁN thuần (không fs/net/db) nên không phá luật "compiler PURE".
 *
 * TODO(M2) zstd: `planFormatVersion = 1` là payload THÔ, CHƯA NÉN. Nén nằm ở tầng lưu trữ/
 * truyền của orchestration, không phải ở đây — và khi bật, nó phải nén CHÍNH chuỗi canonical
 * này, để `contentHash` không đổi nghĩa. Đổi cách nén ⇒ bump `planFormatVersion` lên 2.
 */
import { createHash } from "node:crypto";
import type { ResolvedCase, ResolvedStep } from "./phase45-resolve.js";

/** Version của FORMAT plan (không phải version của compiler): 1 = canonical JSON thô, chưa nén. */
export const PLAN_FORMAT_VERSION = 1;

export const CHAIN_TIMEOUT_BASE_SECONDS = 90;
export const CHAIN_TIMEOUT_PER_STEP_SECONDS = 12;
export const MIN_CHAIN_TIMEOUT_SECONDS = 180;
export const MAX_CHAIN_TIMEOUT_SECONDS = 900;

/** Lane quyết định chính sách ảnh + kiểu worker (§5.2, §5). */
export type RunLane = "interactive" | "batch";

/** `all` = mọi step; `failure` = chỉ upload khi chain fail; `none` = tắt hẳn. */
export type ScreenshotPolicy = "all" | "failure" | "none";

export interface RunPolicy {
  readonly lane: RunLane;
  readonly engine: "chromium-headless-shell";
  /** AssertionFailure là verdict, không phải sự cố — chỉ lỗi hạ tầng mới được retry. */
  readonly retry: "infra-only";
  readonly screenshots: ScreenshotPolicy;
  readonly baseUrl: string;
}

/** Case đã freeze = ResolvedCase của phase 4+5, không thêm gì (mọi thứ đã bất biến từ đó). */
export type CasePlan = ResolvedCase;
export type StepPlan = ResolvedStep;

export interface ChainPlan {
  readonly chainKey: string;
  readonly cases: readonly CasePlan[];
  /** Tổng step tĩnh của chain — dispatcher tính cost từ đây, khỏi duyệt lại cây. */
  readonly stepCount: number;
  readonly timeoutSeconds: number;
}

export interface RunPlan {
  readonly planFormatVersion: typeof PLAN_FORMAT_VERSION;
  readonly teamId: string;
  readonly projectId: string;
  readonly policy: RunPolicy;
  /** Mỗi chain = prereq + target — ĐƠN VỊ JOB của fleet. */
  readonly chains: readonly ChainPlan[];
  /** SHA-256 hex của canonical JSON phần còn lại của plan này. */
  readonly contentHash: string;
}

/** Payload thật sự bị hash: toàn bộ plan TRỪ chính contentHash. */
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
  /** Override per-run; vắng mặt ⇒ mặc định theo lane. */
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
 * Trần thời gian của MỘT chain. Vòng lặp `for`/`while` chỉ được đếm bằng kích thước TĨNH
 * của thân vòng (số lần lặp thật chỉ worker mới biết) — trần 900s là thứ chặn trường hợp đó.
 */
export function chainTimeoutSeconds(stepCount: number): number {
  const raw = CHAIN_TIMEOUT_BASE_SECONDS + CHAIN_TIMEOUT_PER_STEP_SECONDS * stepCount;
  return Math.min(MAX_CHAIN_TIMEOUT_SECONDS, Math.max(MIN_CHAIN_TIMEOUT_SECONDS, raw));
}

/** Đếm ĐỆ QUY mọi node step (kể cả node cấu trúc) của mọi iteration trong chain. */
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
 * JSON canonical: key của object sort theo code unit (đệ quy), mảng giữ nguyên thứ tự,
 * field `undefined` bị bỏ đúng như khi nó vắng mặt.
 *
 * Cố ý KHÔNG khoan dung: gặp thứ không thuộc JSON (NaN, hàm, Date, Map, instance class…)
 * thì NÉM, chứ không im lặng biến nó thành `null`/`{}` — một plan hash sai là một plan sai
 * mãi mãi, và lỗi kiểu đó không có cách nào phát hiện về sau.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined) {
    throw new Error("canonicalJson: giá trị gốc là undefined — không có payload nào để hash");
  }
  return encoded;
}

/** `undefined` = "field này biến mất" (chỉ hợp lệ bên trong object). */
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
        throw new Error(`canonicalJson: số phải hữu hạn, gặp ${String(value)}`);
      }
      return JSON.stringify(value);
    case "object":
      return encodeObject(value);
    default:
      throw new Error(`canonicalJson: kiểu "${typeof value}" không thuộc JSON — payload sai từ gốc`);
  }
}

function encodeObject(value: object): string {
  if (Array.isArray(value)) {
    // Phần tử undefined trong mảng thành null (đúng ngữ nghĩa JSON): bỏ nó đi sẽ làm lệch index.
    const items: readonly unknown[] = value;
    return `[${items.map((item) => encode(item) ?? "null").join(",")}]`;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(
      `canonicalJson: chỉ chấp nhận object thuần — gặp instance của "${value.constructor.name}"`,
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

/** So sánh theo code unit UTF-16, KHÔNG theo locale — hash phải giống nhau trên mọi máy. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
