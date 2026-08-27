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

export interface VerbDefinition {
  /** op_key ổn định — action_catalog.op_key validate với registry này lúc boot (fail-fast). */
  readonly opKey: string;
  /** Câu mẫu hiển thị cho QA — placeholder trong ngoặc nhọn. */
  readonly sentence: string;
  readonly params: readonly VerbParamSpec[];
  /** true nếu op cần layout thật (actionability) — tài liệu hóa cho audit engine. */
  readonly needsRendering: boolean;
  readonly execute: (ctx: OpContext, args: Record<string, string>) => Promise<OpResult>;
}

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

// ---------------------------------------------------------------------------
// 2 verb đầu tiên (chiếm 55,7% tổng step production) — làm mẫu cho 33 verb còn lại.
// TODO(M4): implement thân op trên Playwright + engine golden test (T2) cho từng verb.
// ---------------------------------------------------------------------------

registerVerb({
  opKey: "web.click",
  sentence: "Click on {element}",
  params: [{ name: "element", kind: "element", required: true }],
  needsRendering: true, // actionability: visible + stable + receives-events + enabled
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.click()");
  },
});

registerVerb({
  opKey: "web.enter",
  sentence: "Enter {test-data} in {element} field",
  params: [
    { name: "test-data", kind: "test-data", required: true },
    { name: "element", kind: "element", required: true },
  ],
  needsRendering: true, // fill: visible + enabled + editable
  execute: async () => {
    throw new Error("TODO(M4): implement on Playwright locator.fill()");
  },
});
