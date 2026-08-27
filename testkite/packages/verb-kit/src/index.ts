/**
 * @testkite/verb-kit — op registry: verb NLP → op thực thi Playwright.
 *
 * Thay thế cơ chế Class.forName của Testsigma cũ (586 dòng natural_text_actions
 * reflection theo tên class — lỗi chỉ lộ lúc runtime). Ở đây: verb là DATA,
 * op là CODE, compiler bind verb→op ở compile-time và GOM MỌI LỖI trước khi
 * bất kỳ browser nào khởi động.
 *
 * Census production: 35 verb phủ 99% của 52.900 step. Port theo histogram:
 * click (15.485) → enter (13.691) → navigateTo (3.341) → ... (docs/asset-census.sql)
 */
import { z } from "zod";

/** Placeholder một verb có thể khai báo trong câu. */
export type VerbParamKind = "element" | "test-data" | "attribute" | "raw";

export interface VerbParamSpec {
  readonly name: string;
  readonly kind: VerbParamKind;
  readonly required: boolean;
}

/** Ngữ cảnh thực thi op — worker cung cấp, op không bao giờ tự tạo browser/context. */
export interface OpContext {
  /** Playwright Page của context hiện tại (chromium-headless-shell). */
  readonly page: unknown; // TODO(M4): import type { Page } from "playwright-core"
  readonly stepTimeoutMs: number;
  readonly log: (msg: string) => void;
}

export interface OpResult {
  readonly ok: boolean;
  /** Chỉ set khi ok=false — trở thành AssertionFailure (verdict), không phải infra error. */
  readonly failureMessage?: string;
}

/**
 * Schema args của một verb: args luôn là bản đồ chuỗi→chuỗi (giá trị thật do worker
 * resolve lúc chạy — secret giữ nguyên dạng `$secret:<name>` qua compiler).
 */
export type VerbArgsSchema = z.ZodType<Record<string, string>>;

export interface VerbDefinition {
  /** op_key ổn định — action_catalog.op_key validate với registry này lúc boot (fail-fast). */
  readonly opKey: string;
  /** Câu mẫu hiển thị cho QA — placeholder trong ngoặc nhọn, tên trùng `params[].name`. */
  readonly sentence: string;
  readonly params: readonly VerbParamSpec[];
  /**
   * Hợp đồng args cho compiler phase 3 (`verb_args_invalid` bắt TRƯỚC khi browser chạy).
   * Optional có chủ đích: verb port trước khi có schema vẫn đăng ký được — thiếu schema
   * nghĩa là "chưa kiểm", không phải "hợp lệ mọi thứ" (33 verb còn lại sẽ bù dần ở M4).
   */
  readonly argsSchema?: VerbArgsSchema;
  /** true nếu op cần layout thật (actionability) — tài liệu hóa cho audit engine. */
  readonly needsRendering: boolean;
  readonly execute: (ctx: OpContext, args: Record<string, string>) => Promise<OpResult>;
}

/** Kết quả validateArgs — GOM mọi issue, không first-fail (luật compiler §4). */
export type ArgsValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly string[] };

const registry = new Map<string, VerbDefinition>();

export function registerVerb(def: VerbDefinition): void {
  if (registry.has(def.opKey)) throw new Error(`duplicate opKey: ${def.opKey}`);
  registry.set(def.opKey, def);
}

export function getVerb(opKey: string): VerbDefinition | undefined {
  return registry.get(opKey);
}

export function allVerbs(): readonly VerbDefinition[] {
  return [...registry.values()];
}

/**
 * Kiểm args của một step so với schema của verb — hàm PURE, không I/O, dùng được
 * trong compiler. Verb chưa khai báo argsSchema ⇒ ok (không chặn verb đang port).
 */
export function validateArgs(opKey: string, args: Readonly<Record<string, string>>): ArgsValidation {
  const verb = registry.get(opKey);
  if (verb === undefined) return { ok: false, issues: [`opKey không có trong registry: ${opKey}`] };

  const schema = verb.argsSchema;
  if (schema === undefined) return { ok: true };

  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };

  return { ok: false, issues: parsed.error.issues.map(formatIssue) };
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** Tham chiếu element/dữ liệu: chuỗi rỗng là lỗi tác giả, không phải "giá trị rỗng hợp lệ". */
const requiredArg = z.string().min(1);

// ---------------------------------------------------------------------------
// 2 verb đầu tiên (chiếm 55,7% tổng step production) — làm mẫu cho 33 verb còn lại.
// TODO(M4): implement thân op trên Playwright + engine golden test (T2) cho từng verb.
// ---------------------------------------------------------------------------

registerVerb({
  opKey: "web.click",
  sentence: "Click on {element}",
  params: [{ name: "element", kind: "element", required: true }],
  argsSchema: z.object({ element: requiredArg }),
  needsRendering: true, // actionability: visible + stable + receives-events + enabled
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.click()");
  },
});

registerVerb({
  opKey: "web.enter",
  sentence: "Enter {value} in {element} field",
  params: [
    // kind=test-data: giá trị đến từ data profile/env; name = KHÓA args, phải khớp argsSchema.
    { name: "value", kind: "test-data", required: true },
    { name: "element", kind: "element", required: true },
  ],
  argsSchema: z.object({ element: requiredArg, value: requiredArg }),
  needsRendering: true, // fill: visible + enabled + editable
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.fill()");
  },
});
