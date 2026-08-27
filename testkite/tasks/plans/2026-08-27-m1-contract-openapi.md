# M1 — Contract/OpenAPI + Toolchain Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng hai dòng checklist M1 còn hở — (A) zod schema authoring-facing cho case/step/element/run, sinh OpenAPI 3.1 commit vào repo, CI fail khi regen drift; (B) biến ba luật kiến trúc đang chỉ nằm trong comment (DAG 12 module, compiler PURE, `bullmq` chỉ trong kernel) thành lint chặn được ở CI.

**Architecture:** zod là NGUỒN hợp đồng duy nhất trong `packages/contract`; OpenAPI 3.1 là ĐẦU RA sinh ra từ đó bằng `zod-openapi`, commit tại `packages/contract/openapi.json`, gate CI = regen rồi `git diff --exit-code`. Toolchain: eslint flat config ở gốc `testkite/`, DAG khai báo dạng DỮ LIỆU (`module-dag.json`) song song `ownership.json` và có test bắt lệch giữa hai file; `eslint-plugin-boundaries` cưỡng chế DAG, `no-restricted-imports/globals/properties` cưỡng chế purity, `madge --circular` bắt vòng lặp file. Mọi luật lint có FIXTURE VI PHẠM thường trú trong `tools/lint-fixtures/` + test chạy ESLint Node API khẳng định luật vẫn bắt — luật lint được TDD như code.

**Tech Stack:** Node 22, TypeScript ~5.7.3 strict, pnpm 9 workspace, vitest 3, zod ^3.24.1 (lock 3.25.76), `zod-openapi@4.2.4` (pin exact), `tsx@^4.23`, `eslint@^10.9`, `typescript-eslint@^8.68`, `eslint-plugin-boundaries@^7.2`, `eslint-import-resolver-typescript@^4.4`, `madge@^8`.

**Spec:** `../M1-kernel-contracts-compiler.md` (hai dòng checklist chưa tick: dòng `contract:` và dòng toolchain đầu file) + `../../../docs/SYSTEM_DESIGN.md` §4 (12 module DAG một chiều, OpenAPI sinh từ zod, CI chặn drift) + `../../ownership.json` + `../../../CLAUDE.md` Luật 4.

## Global Constraints

- TypeScript strict + `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`, NodeNext, Node 22. Không `any`, không `!` phi lý.
- **`exactOptionalPropertyTypes` đòi mọi prop optional của DTO viết `?: T | undefined`.** Viết `?: T` là `pnpm typecheck` ĐỎ khi gán từ `z.infer` — đã xác minh: `Type 'Record<string, string> | undefined' is not assignable to type 'Record<string, string>'`. Đây là lỗi số 1 khi viết task A1–A4.
- Compiler (`packages/run-compiler`) PURE: cấm fs/net/db, cấm `Date.now()`/`Math.random()`/`process`. `node:crypto` ĐƯỢC PHÉP (phase 7 hash bằng `createHash`).
- `packages/contract` KHÔNG được import `@testkite/run-compiler` (ngược DAG). Chiều hợp lệ duy nhất: run-compiler → contract.
- Mọi file mới trong `packages/contract/src/` phải nằm dưới `src/` (tsconfig `include: ["src"]`).
- Import nội bộ dùng đuôi `.js` (NodeNext), kể cả khi file nguồn là `.ts`.
- Commit nhỏ sau mỗi task; TDD đúng nghi thức (test ĐỎ trước, code sau). Tick checkbox `testkite/tasks/M1-kernel-contracts-compiler.md` kèm hash ở task cuối.
- File plan/code KHÔNG nhắc tên trợ lý AI nào.

---

## Quyết định thư viện OpenAPI (đã spike, không mở lại)

**Chọn: `zod-openapi@4.2.4` (pin exact, không caret).**

Bằng chứng thu bằng `pnpm info` + spike chạy thật (ngày 2026-08-27, zod trong lockfile = **3.25.76**):

| Tiêu chí | `zod-openapi` | `@asteasolutions/zod-to-openapi` |
|---|---|---|
| Bản mới nhất | `6.0.1` — peer `zod: ^4.0.0` ❌ | `9.1.0` — peer `zod: ^4.0.0` ❌ |
| Bản cuối còn ăn zod v3 | **`4.2.4`** — peer `zod: ^3.21.4` ✅ phủ TRỌN dải khai báo `^3.24.1` | **`7.3.4`** — peer `zod: ^3.20.2` ✅ |
| (bản kế tiếp) | `5.0.0` peer `^3.25.74` — KHÔNG phủ `3.24.x`, chỉ tình cờ hợp lockfile hiện tại ⇒ loại | `8.0.0` đã nhảy sang zod v4 ⇒ loại |
| Runtime deps | **0** | `openapi3-ts@^4.1.2` (resolve 4.6.1) |
| Cần vá prototype zod? | **KHÔNG.** Spike xác nhận `z.string().openapi === undefined` mà `$ref` vẫn dedup qua `components.schemas` | **CÓ, bắt buộc.** Bỏ `extendZodWithOpenApi(z)` ⇒ ném `TypeError: zodSchema.openapi is not a function` |
| Literal → 3.1 | `"const": "action"` (idiom JSON Schema 2020-12) | `"enum": ["action"]` (dư âm 3.0) |
| Nullable → 3.1 | `"type": ["string","null"]` ✅ | `"type": ["string","null"]` ✅ |
| Đệ quy (`z.lazy` tự trỏ) | `{"$ref":"#/components/schemas/AuthoredStep"}` ✅ | (không spike — đã loại vì tiêu chí trên) |
| Ổn định đầu ra (gate drift) | 3 lần chạy ⇒ cùng sha256 ✅ | 3 lần chạy ⇒ cùng sha256 ✅ |
| Rác trong spec commit | không | thêm `"parameters": {}` và `"webhooks": {}` rỗng |

**Lý do quyết định (theo thứ tự sức nặng):**

1. **Không vá prototype.** `@testkite/contract` bị `@testkite/run-compiler` import, mà run-compiler phải PURE (CLAUDE.md Luật 4). `extendZodWithOpenApi(z)` là mutation toàn cục lên module `zod` dùng chung — nạp contract là đổi hành vi zod cho cả compiler. `zod-openapi` không đòi điều đó.
2. **Zero runtime deps** trong đúng package mà mọi thứ khác import.
3. **`const` thay vì `enum` một phần tử** — đúng 3.1, tốt hơn cho `oasdiff` và codegen ở M2.
4. **Một nguồn sự thật.** `@asteasolutions` cần `OpenAPIRegistry` riêng: thứ tự gọi `.register()` quyết định thứ tự key `components.schemas` ⇒ thêm schema có thể làm xáo trộn spec commit, đúng chỗ đau nhất của gate drift.

**Pin exact `4.2.4`** (không `^4.2.4`): gate drift so byte; một bản patch đổi cách emit là CI đỏ trên PR không liên quan.

**Phạm vi M1 = CATALOG SCHEMA, chưa có `paths`.** M1 chưa có route Fastify nào (`apps/core/src/composition-root.ts` còn là `throw new Error("TODO(M1)")`). Sinh `paths` bây giờ là bịa. OpenAPI 3.1 cho phép thiếu `paths` (khác 3.0) — đã xác minh `createDocument` không phát key `paths` khi không truyền. M2 gắn route thật thì bổ sung `paths` vào cùng generator này; gate drift đã đứng sẵn từ M1.

---

## File Structure

**Phần A — contract + OpenAPI**

| File | Trách nhiệm |
|---|---|
| `testkite/packages/contract/src/schemas/element.ts` | `locatorSchema`, `elementStatusSchema`, `elementSchema` + DTO types |
| `testkite/packages/contract/src/schemas/element.test.ts` | test parse dương/âm cho element |
| `testkite/packages/contract/src/schemas/step.ts` | `authoredStepSchema` (discriminated union 6 `kind`, đệ quy `children`) + DTO types |
| `testkite/packages/contract/src/schemas/step.test.ts` | test parse dương/âm cho step |
| `testkite/packages/contract/src/schemas/case.ts` | `authoredCaseSchema`, `dataRowSchema`, `dataProfileSchema`, `envSchema`, `compileSnapshotSchema` |
| `testkite/packages/contract/src/schemas/case.test.ts` | test parse dương/âm cho case/data/env |
| `testkite/packages/contract/src/schemas/run.ts` | `COMPILE_ERROR_CODES` (chuyển về đây), `compileDiagnosticSchema`, `runVerdictSchema`, `jobStatusSchema`, `jobKindSchema`, `laneSchema`, `runSchema` |
| `testkite/packages/contract/src/schemas/run.test.ts` | test parse dương/âm cho run/diagnostic |
| `testkite/packages/contract/src/schemas/index.ts` | barrel gom 4 file trên |
| `testkite/packages/contract/src/openapi.ts` | `buildOpenApiDocument()` (thuần) + `serializeOpenApiDocument()` |
| `testkite/packages/contract/src/openapi.test.ts` | version 3.1.0, đủ schema, `$ref` toàn vẹn, sinh 2 lần ⇒ byte giống hệt |
| `testkite/packages/contract/src/openapi.gen.ts` | entry CLI: ghi `openapi.json` |
| `testkite/packages/contract/openapi.json` | **spec commit** — sinh ra, gate drift canh |
| `testkite/packages/contract/src/index.ts` (sửa) | re-export `./schemas/index.js` + `./openapi.js` |
| `testkite/packages/run-compiler/src/index.ts` (sửa) | re-export `COMPILE_ERROR_CODES` từ contract thay vì tự khai (chống lệch danh mục) |
| `testkite/packages/run-compiler/src/contract-conformance.test.ts` | 20+ fixture authoring phải parse lọt schema contract; key-set DTO khớp type snapshot |

**Phần B — toolchain**

| File | Trách nhiệm |
|---|---|
| `testkite/module-dag.json` | DAG 12 module dạng DỮ LIỆU: module → danh sách module được phép import |
| `testkite/eslint.config.mjs` | flat config: parser TS, boundaries DAG, purity compiler, cấm queue ngoài kernel |
| `testkite/.madgerc` | `skipTypeImports` + `tsConfig` cho madge |
| `testkite/tools/lint-fixtures/**` | file vi phạm/hợp lệ mẫu — KHÔNG nằm trong đường lint chính |
| `testkite/tools/lint-rules.test.ts` | chạy ESLint Node API trên fixture, khẳng định từng luật vẫn bắt |
| `testkite/tools/module-dag.test.ts` | `module-dag.json` và `ownership.json` phải cùng bộ 12 key; DAG phải acyclic |
| `testkite/package.json` (sửa) | scripts `lint`, `lint:cycles`, `openapi:gen`, `openapi:check` |
| `.github/workflows/testkite-ci.yml` (sửa) | thêm 3 bước: openapi drift, lint, madge |

**Vì sao `eslint.config.mjs` chứ không `.js`:** `testkite/package.json` KHÔNG có `"type": "module"` ⇒ `.js` ở gốc là CommonJS, mà flat config phải ESM. Đuôi `.mjs` là cách duy nhất không phải đụng vào field `type` của workspace root.

---

# PHẦN A — Contract + OpenAPI

## Task A1 — Schema element + locator

**Files:**
- Create: `testkite/packages/contract/src/schemas/element.ts`
- Test: `testkite/packages/contract/src/schemas/element.test.ts`

**Interfaces:**
- Consumes: `zod` (đã là dependency của `@testkite/contract`).
- Produces: `locatorSchema`, `elementStatusSchema`, `elementSchema`; types `LocatorDto`, `ElementStatusDto`, `ElementDto`. Task A3 dùng `elementSchema`; Task A5 đưa cả ba vào `components.schemas`.

**Ngữ cảnh:** đây là bản zod của `ElementSnapshot` trong `testkite/packages/run-compiler/src/snapshot.ts`. `kind` của locator là chuỗi TỰ DO có chủ đích — fixture hiện có dùng `css`, `xpath`, `text`, `test-id`; đóng thành enum bây giờ là phá fixture và đi trước quyết định của M4.

- [x] **Step 1: Viết test ĐỎ**

Tạo `testkite/packages/contract/src/schemas/element.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { elementSchema, locatorSchema } from "./element.js";

describe("locatorSchema", () => {
  it("nhận locator hợp lệ", () => {
    expect(locatorSchema.parse({ kind: "css", value: "#login" })).toEqual({ kind: "css", value: "#login" });
  });

  it("nhận kind ngoài danh sách quen thuộc (kind là chuỗi tự do)", () => {
    expect(locatorSchema.parse({ kind: "test-id", value: "account-menu" }).kind).toBe("test-id");
  });

  it("từ chối kind rỗng", () => {
    expect(locatorSchema.safeParse({ kind: "", value: "#login" }).success).toBe(false);
  });
});

describe("elementSchema", () => {
  const ok = {
    id: "el-signin",
    name: "Sign in button",
    status: "ready",
    locators: [{ kind: "css", value: "#signin" }],
  };

  it("nhận element ready", () => {
    expect(elementSchema.parse(ok).status).toBe("ready");
  });

  it("nhận element pending_locator", () => {
    expect(elementSchema.parse({ ...ok, status: "pending_locator" }).status).toBe("pending_locator");
  });

  it("từ chối status lạ", () => {
    expect(elementSchema.safeParse({ ...ok, status: "draft" }).success).toBe(false);
  });

  it("từ chối locators rỗng — element không locator là dữ liệu vô nghĩa", () => {
    expect(elementSchema.safeParse({ ...ok, locators: [] }).success).toBe(false);
  });

  it("GOM mọi issue chứ không dừng ở lỗi đầu", () => {
    const r = elementSchema.safeParse({ id: "", name: "", status: "draft", locators: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/element.test.ts`
Expected: FAIL — `Failed to resolve import "./element.js"`.

- [x] **Step 3: Viết implementation tối thiểu**

Tạo `testkite/packages/contract/src/schemas/element.ts`:

```ts
/**
 * DTO authoring-facing cho element. Soi gương `ElementSnapshot`
 * (packages/run-compiler/src/snapshot.ts) — compiler nhận đúng hình dạng này.
 *
 * `exactOptionalPropertyTypes: true`: mọi prop optional phải khai `?: T | undefined`,
 * nếu không phép gán từ `z.infer` sẽ hỏng lúc typecheck.
 */
import { z } from "zod";

/**
 * `kind` là chuỗi tự do có chủ đích: catalog locator còn mở tới M4
 * (fixture hiện dùng css | xpath | text | test-id). Đóng enum sớm = phá fixture.
 */
export const locatorSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export const ELEMENT_STATUSES = ["ready", "pending_locator"] as const;
export const elementStatusSchema = z.enum(ELEMENT_STATUSES);

export const elementSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: elementStatusSchema,
  /** ≥1: element không locator không thể bind ở phase 4 — chặn tại biên API. */
  locators: z.array(locatorSchema).min(1),
});

export interface LocatorDto {
  kind: string;
  value: string;
}

export type ElementStatusDto = (typeof ELEMENT_STATUSES)[number];

export interface ElementDto {
  id: string;
  name: string;
  status: ElementStatusDto;
  locators: LocatorDto[];
}
```

- [x] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/element.test.ts`
Expected: PASS (8 test).

- [x] **Step 5: Typecheck**

Run: `cd testkite && pnpm typecheck`
Expected: exit 0.

- [x] **Step 6: Commit**

```bash
git add testkite/packages/contract/src/schemas/element.ts testkite/packages/contract/src/schemas/element.test.ts
git commit -m "M1 A1: contract zod schema element + locator"
```

---

## Task A2 — Schema step (union 6 kind, đệ quy)

**Files:**
- Create: `testkite/packages/contract/src/schemas/step.ts`
- Test: `testkite/packages/contract/src/schemas/step.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces: `STEP_KINDS`, `stepKindSchema`, `authoredStepSchema: z.ZodType<AuthoredStepDto>`; types `AuthoredStepDto` (union), `ActionStepDto`, `StepGroupStepDto`, `IfStepDto`, `ForStepDto`, `WhileStepDto`, `RestStepDto`. Task A3 dùng `authoredStepSchema`; Task A5 đăng ký nó dưới key `AuthoredStep`.

**Ngữ cảnh:** bản zod của `AuthoredStep` trong `run-compiler/src/snapshot.ts`. Sáu `kind`: `action | step_group | if | for | while | rest`. Đệ quy: `if`/`for`/`while` có `children: AuthoredStepDto[]`.

**Hai cái bẫy đã xác minh bằng spike, đừng vấp:**
1. Schema đệ quy PHẢI khai type thủ công rồi chú thích `z.ZodType<AuthoredStepDto>` + bọc `z.lazy(...)`. Không có chú thích thì TypeScript không suy được kiểu tự trỏ.
2. Prop optional trong interface DTO phải viết `?: T | undefined`. Viết `args?: Record<string, string>` là tsc đỏ với `exactOptionalPropertyTypes`.

- [x] **Step 1: Viết test ĐỎ**

Tạo `testkite/packages/contract/src/schemas/step.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authoredStepSchema } from "./step.js";

const action = {
  kind: "action" as const,
  ordinal: 1,
  renderedSentence: "Click on el-signin",
  verbOpKey: "web.click",
  args: {},
  elementId: "el-signin",
};

describe("authoredStepSchema — action", () => {
  it("nhận action đủ trường", () => {
    expect(authoredStepSchema.parse(action)).toMatchObject({ kind: "action", verbOpKey: "web.click" });
  });

  it("nhận action không elementId (verb không cần element)", () => {
    const { elementId: _drop, ...noElement } = action;
    expect(authoredStepSchema.safeParse(noElement).success).toBe(true);
  });

  it("từ chối action thiếu verbOpKey", () => {
    const { verbOpKey: _drop, ...noVerb } = action;
    expect(authoredStepSchema.safeParse(noVerb).success).toBe(false);
  });

  it("từ chối ordinal 0 — ordinal đếm từ 1 như fixture", () => {
    expect(authoredStepSchema.safeParse({ ...action, ordinal: 0 }).success).toBe(false);
  });

  it("từ chối args có value không phải chuỗi — secret giữ dạng $secret:NAME, luôn là chuỗi", () => {
    expect(authoredStepSchema.safeParse({ ...action, args: { timeout: 30 } }).success).toBe(false);
  });
});

describe("authoredStepSchema — block", () => {
  it("nhận if lồng action trong children", () => {
    const parsed = authoredStepSchema.parse({
      kind: "if",
      ordinal: 1,
      renderedSentence: "If login succeeded",
      conditionExpected: ["SUCCESS"],
      children: [{ ...action, ordinal: 1 }],
    });
    expect(parsed).toMatchObject({ kind: "if" });
  });

  it("nhận if lồng if (đệ quy 2 tầng)", () => {
    const inner = { kind: "if", ordinal: 1, renderedSentence: "inner", conditionExpected: ["SUCCESS"], children: [action] };
    const outer = { kind: "if", ordinal: 1, renderedSentence: "outer", conditionExpected: ["SUCCESS"], children: [inner] };
    expect(authoredStepSchema.safeParse(outer).success).toBe(true);
  });

  it("từ chối if không conditionExpected", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "if", ordinal: 1, renderedSentence: "x", children: [] }).success,
    ).toBe(false);
  });

  it("từ chối while thiếu maxIterations — while không trần là while vô hạn", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "while", ordinal: 1, renderedSentence: "x", children: [action] }).success,
    ).toBe(false);
  });

  it("nhận while có maxIterations", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "while",
        ordinal: 1,
        renderedSentence: "x",
        maxIterations: 5,
        children: [action],
      }).success,
    ).toBe(true);
  });

  it("nhận for có loopDataProfileId", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "for",
        ordinal: 1,
        renderedSentence: "x",
        loopDataProfileId: "p-logins",
        children: [action],
      }).success,
    ).toBe(true);
  });

  it("nhận step_group có stepGroupCaseId", () => {
    expect(
      authoredStepSchema.safeParse({
        kind: "step_group",
        ordinal: 1,
        renderedSentence: "Run group login",
        stepGroupCaseId: "grp-login",
      }).success,
    ).toBe(true);
  });

  it("nhận rest", () => {
    expect(
      authoredStepSchema.safeParse({ kind: "rest", ordinal: 1, renderedSentence: "GET /health", args: {} }).success,
    ).toBe(true);
  });

  it("từ chối kind lạ", () => {
    expect(authoredStepSchema.safeParse({ ...action, kind: "goto" }).success).toBe(false);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/step.test.ts`
Expected: FAIL — không resolve được `./step.js`.

- [x] **Step 3: Viết implementation tối thiểu**

Tạo `testkite/packages/contract/src/schemas/step.ts`:

```ts
/**
 * DTO authoring-facing cho step. Soi gương `AuthoredStep`
 * (packages/run-compiler/src/snapshot.ts).
 *
 * HAI RÀNG BUỘC KHÔNG ĐƯỢC BỎ:
 *  1. Đệ quy (`children`) ⇒ phải khai type thủ công rồi chú thích
 *     `z.ZodType<AuthoredStepDto>` + `z.lazy(...)`.
 *  2. `exactOptionalPropertyTypes: true` ⇒ prop optional viết `?: T | undefined`.
 */
import { z } from "zod";

export const STEP_KINDS = ["action", "step_group", "if", "for", "while", "rest"] as const;
export const stepKindSchema = z.enum(STEP_KINDS);
export type StepKindDto = (typeof STEP_KINDS)[number];

export interface ActionStepDto {
  kind: "action";
  ordinal: number;
  renderedSentence: string;
  verbOpKey: string;
  args?: Record<string, string> | undefined;
  elementId?: string | undefined;
}

export interface StepGroupStepDto {
  kind: "step_group";
  ordinal: number;
  renderedSentence: string;
  stepGroupCaseId: string;
}

export interface IfStepDto {
  kind: "if";
  ordinal: number;
  renderedSentence: string;
  conditionExpected: string[];
  children: AuthoredStepDto[];
}

export interface ForStepDto {
  kind: "for";
  ordinal: number;
  renderedSentence: string;
  loopDataProfileId: string;
  children: AuthoredStepDto[];
}

export interface WhileStepDto {
  kind: "while";
  ordinal: number;
  renderedSentence: string;
  /** BẮT BUỘC: while không trần lặp là while vô hạn (compiler: while_without_max_iterations). */
  maxIterations: number;
  children: AuthoredStepDto[];
}

export interface RestStepDto {
  kind: "rest";
  ordinal: number;
  renderedSentence: string;
  args?: Record<string, string> | undefined;
}

export type AuthoredStepDto =
  | ActionStepDto
  | StepGroupStepDto
  | IfStepDto
  | ForStepDto
  | WhileStepDto
  | RestStepDto;

/** Trường chung mọi kind — ordinal đếm từ 1 (khớp fixture run-compiler). */
const stepCommon = {
  ordinal: z.number().int().positive(),
  renderedSentence: z.string().min(1),
};

/** args luôn là bản đồ chuỗi→chuỗi: secret đi qua compiler ở dạng `$secret:<name>`. */
const argsSchema = z.record(z.string());

export const authoredStepSchema: z.ZodType<AuthoredStepDto> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("action"),
      ...stepCommon,
      verbOpKey: z.string().min(1),
      args: argsSchema.optional(),
      elementId: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("step_group"),
      ...stepCommon,
      stepGroupCaseId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("if"),
      ...stepCommon,
      conditionExpected: z.array(z.string().min(1)).min(1),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("for"),
      ...stepCommon,
      loopDataProfileId: z.string().min(1),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("while"),
      ...stepCommon,
      maxIterations: z.number().int().positive(),
      children: z.array(authoredStepSchema),
    }),
    z.object({
      kind: z.literal("rest"),
      ...stepCommon,
      args: argsSchema.optional(),
    }),
  ]),
);
```

- [x] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/step.test.ts`
Expected: PASS (13 test).

- [x] **Step 5: Typecheck**

Run: `cd testkite && pnpm typecheck`
Expected: exit 0. Nếu ĐỎ ở `z.ZodType<AuthoredStepDto>` với thông điệp `Type 'undefined' is not assignable`, nghĩa là còn prop optional nào đó thiếu `| undefined` — sửa interface, đừng nới schema.

- [x] **Step 6: Commit**

```bash
git add testkite/packages/contract/src/schemas/step.ts testkite/packages/contract/src/schemas/step.test.ts
git commit -m "M1 A2: contract zod schema step (union 6 kind, đệ quy)"
```

---

## Task A3 — Schema case + data profile + env + snapshot

**Files:**
- Create: `testkite/packages/contract/src/schemas/case.ts`
- Create: `testkite/packages/contract/src/schemas/index.ts`
- Test: `testkite/packages/contract/src/schemas/case.test.ts`

**Interfaces:**
- Consumes: `elementSchema`/`ElementDto` (A1), `authoredStepSchema`/`AuthoredStepDto` (A2).
- Produces: `authoredCaseSchema`, `dataRowSchema`, `dataProfileSchema`, `envSchema`, `compileSnapshotSchema`; types `AuthoredCaseDto`, `DataRowDto`, `DataProfileDto`, `EnvDto`, `CompileSnapshotDto`. Task A5 đăng ký tất cả vào `components.schemas`; Task A6 dùng `compileSnapshotSchema` trong test conformance.

- [x] **Step 1: Viết test ĐỎ**

Tạo `testkite/packages/contract/src/schemas/case.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authoredCaseSchema, compileSnapshotSchema, dataProfileSchema, envSchema } from "./case.js";

const step = { kind: "action" as const, ordinal: 1, renderedSentence: "Click", verbOpKey: "web.click", args: {} };

const baseCase = {
  id: "checkout",
  revisionId: "rev-checkout-001",
  name: "Checkout happy path",
  isStepGroup: false,
  steps: [step],
};

describe("authoredCaseSchema", () => {
  it("nhận case tối thiểu", () => {
    expect(authoredCaseSchema.parse(baseCase).id).toBe("checkout");
  });

  it("nhận case có prereqCaseId và dataProfileId", () => {
    const r = authoredCaseSchema.safeParse({ ...baseCase, prereqCaseId: "login", dataProfileId: "p-logins" });
    expect(r.success).toBe(true);
  });

  it("nhận step group (isStepGroup=true)", () => {
    expect(authoredCaseSchema.parse({ ...baseCase, isStepGroup: true }).isStepGroup).toBe(true);
  });

  it("từ chối case thiếu revisionId — không ghim revision là không tái lập được run", () => {
    const { revisionId: _drop, ...noRev } = baseCase;
    expect(authoredCaseSchema.safeParse(noRev).success).toBe(false);
  });

  it("nhận case steps rỗng (case mới tạo, compiler sẽ xử)", () => {
    expect(authoredCaseSchema.safeParse({ ...baseCase, steps: [] }).success).toBe(true);
  });
});

describe("dataProfileSchema", () => {
  it("nhận profile có cờ expectedToFail", () => {
    const parsed = dataProfileSchema.parse({
      id: "p-logins",
      rows: [{ label: "locked-user", expectedToFail: true, values: { username: "locked@shop.example.com" } }],
    });
    expect(parsed.rows[0]?.expectedToFail).toBe(true);
  });

  it("từ chối row thiếu expectedToFail — mặc định im lặng ở đây là bẫy ngữ nghĩa", () => {
    expect(dataProfileSchema.safeParse({ id: "p", rows: [{ label: "x", values: {} }] }).success).toBe(false);
  });
});

describe("envSchema", () => {
  it("nhận env đủ trường", () => {
    expect(envSchema.parse({ baseUrl: "https://shop.example.com", vars: {}, secretNames: [] }).baseUrl).toBe(
      "https://shop.example.com",
    );
  });

  it("từ chối baseUrl không phải URL", () => {
    expect(envSchema.safeParse({ baseUrl: "shop.example.com", vars: {}, secretNames: [] }).success).toBe(false);
  });
});

describe("compileSnapshotSchema", () => {
  it("nhận snapshot đầy đủ", () => {
    const r = compileSnapshotSchema.safeParse({
      teamId: "team-acme",
      projectId: "proj-web-checkout",
      targetCaseIds: ["checkout"],
      cases: { checkout: baseCase },
      elements: {},
      dataProfiles: {},
      env: { baseUrl: "https://shop.example.com", vars: {}, secretNames: [] },
    });
    expect(r.success).toBe(true);
  });

  it("từ chối targetCaseIds rỗng — run không target là run rỗng", () => {
    const r = compileSnapshotSchema.safeParse({
      teamId: "t",
      projectId: "p",
      targetCaseIds: [],
      cases: {},
      elements: {},
      dataProfiles: {},
      env: { baseUrl: "https://x.example.com", vars: {}, secretNames: [] },
    });
    expect(r.success).toBe(false);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/case.test.ts`
Expected: FAIL — không resolve được `./case.js`.

- [x] **Step 3: Viết implementation tối thiểu**

Tạo `testkite/packages/contract/src/schemas/case.ts`:

```ts
/**
 * DTO authoring-facing cho case / data profile / env / snapshot compile.
 * Soi gương `AuthoredCase`, `DataProfileSnapshot`, `EnvSnapshot`, `CompileSnapshot`
 * (packages/run-compiler/src/snapshot.ts).
 */
import { z } from "zod";
import { elementSchema } from "./element.js";
import type { ElementDto } from "./element.js";
import { authoredStepSchema } from "./step.js";
import type { AuthoredStepDto } from "./step.js";

export const authoredCaseSchema = z.object({
  id: z.string().min(1),
  /** Ghim revision: schedule/CI chạy bản 'ready', sửa giữa đêm không đổi thứ đang bay. */
  revisionId: z.string().min(1),
  name: z.string().min(1),
  isStepGroup: z.boolean(),
  prereqCaseId: z.string().min(1).optional(),
  dataProfileId: z.string().min(1).optional(),
  /** Rỗng là hợp lệ: case mới tạo chưa có step; compiler quyết ngữ nghĩa, không phải biên API. */
  steps: z.array(authoredStepSchema),
});

export const dataRowSchema = z.object({
  label: z.string().min(1),
  /** BẮT BUỘC tường minh: mặc định im lặng ở đây làm lệch verdict của cả hàng dữ liệu. */
  expectedToFail: z.boolean(),
  values: z.record(z.string()),
});

export const dataProfileSchema = z.object({
  id: z.string().min(1),
  rows: z.array(dataRowSchema),
});

export const envSchema = z.object({
  baseUrl: z.string().url(),
  vars: z.record(z.string()),
  /** Chỉ TÊN secret — plan không bao giờ chứa giá trị, chỉ `$secret:<name>`. */
  secretNames: z.array(z.string().min(1)),
});

export const compileSnapshotSchema = z.object({
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  targetCaseIds: z.array(z.string().min(1)).min(1),
  cases: z.record(authoredCaseSchema),
  elements: z.record(elementSchema),
  dataProfiles: z.record(dataProfileSchema),
  env: envSchema,
});

export interface AuthoredCaseDto {
  id: string;
  revisionId: string;
  name: string;
  isStepGroup: boolean;
  prereqCaseId?: string | undefined;
  dataProfileId?: string | undefined;
  steps: AuthoredStepDto[];
}

export interface DataRowDto {
  label: string;
  expectedToFail: boolean;
  values: Record<string, string>;
}

export interface DataProfileDto {
  id: string;
  rows: DataRowDto[];
}

export interface EnvDto {
  baseUrl: string;
  vars: Record<string, string>;
  secretNames: string[];
}

export interface CompileSnapshotDto {
  teamId: string;
  projectId: string;
  targetCaseIds: string[];
  cases: Record<string, AuthoredCaseDto>;
  elements: Record<string, ElementDto>;
  dataProfiles: Record<string, DataProfileDto>;
  env: EnvDto;
}
```

Tạo `testkite/packages/contract/src/schemas/index.ts`:

```ts
export * from "./element.js";
export * from "./step.js";
export * from "./case.js";
```

- [x] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/`
Expected: PASS — 3 file test, tổng ≥ 28 test.

- [x] **Step 5: Typecheck**

Run: `cd testkite && pnpm typecheck`
Expected: exit 0.

- [x] **Step 6: Commit**

```bash
git add testkite/packages/contract/src/schemas/case.ts testkite/packages/contract/src/schemas/case.test.ts testkite/packages/contract/src/schemas/index.ts
git commit -m "M1 A3: contract zod schema case + data profile + env + snapshot"
```

---

## Task A4 — Schema run + dời `COMPILE_ERROR_CODES` về contract

**Files:**
- Create: `testkite/packages/contract/src/schemas/run.ts`
- Test: `testkite/packages/contract/src/schemas/run.test.ts`
- Modify: `testkite/packages/contract/src/schemas/index.ts` (thêm 1 dòng export)
- Modify: `testkite/packages/run-compiler/src/index.ts:36-50` (bỏ khai báo cục bộ, re-export từ contract)

**Interfaces:**
- Consumes: `RUN_VERDICTS`, `JOB_STATUSES`, `JOB_KINDS`, `LANES` từ `../index.js` (đã có sẵn trong `packages/contract/src/index.ts`).
- Produces: `COMPILE_ERROR_CODES`, `compileErrorCodeSchema`, `compileDiagnosticSchema`, `runVerdictSchema`, `jobStatusSchema`, `jobKindSchema`, `laneSchema`, `runSchema`; types `CompileErrorCode`, `CompileDiagnosticDto`, `RunDto`.

**Vì sao dời `COMPILE_ERROR_CODES`:** `runSchema` cần danh mục lỗi compile, nhưng `contract` KHÔNG được import `run-compiler` (ngược DAG). Chép sang là hai danh sách sẽ lệch. Chiều đúng: contract SỞ HỮU danh mục, run-compiler re-export — nó vốn đã phụ thuộc contract. `golden.test.ts` import `COMPILE_ERROR_CODES` từ `./index.js` nên re-export giữ nguyên mọi call-site, không sửa test nào.

**Lệch so với spec bên dưới (đã thực thi, A5 đọc kỹ):** `run.ts` import hằng từ `../enums.js`
chứ KHÔNG từ `../index.js`. Lý do: bước 5 đòi run-compiler lấy `COMPILE_ERROR_CODES` qua facade
`@testkite/contract`, nên `src/index.ts` phải re-export `./schemas/index.js` NGAY từ A4 — và
barrel re-export schemas + schema đọc ngược barrel = VÒNG IMPORT. Đã dựng lại lỗi thật bằng
`tsx`: `ReferenceError: Cannot access 'RUN_VERDICTS' before initialization` (thân barrel chưa
chạy khi `z.enum(RUN_VERDICTS)` của `run.ts` đọc hằng). **Vitest KHÔNG bắt được** — SSR
transform của vite-node xếp thứ tự khác nên vẫn xanh, nên luật được canh tĩnh bằng test
"không file schema nào import ngược `../index.js`" trong `run.test.ts`.
Cách chữa: tách 4 hằng (`RUN_VERDICTS`, `JOB_STATUSES`, `JOB_KINDS`, `LANES`) sang module LÁ
`packages/contract/src/enums.ts`; `index.ts` re-export lại nên bề mặt facade KHÔNG đổi.
⇒ A5 sửa `index.ts` chỉ còn phải thêm `export * from "./openapi.js";`.

- [x] **Step 1: Viết test ĐỎ**

Tạo `testkite/packages/contract/src/schemas/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES, compileDiagnosticSchema, runSchema } from "./run.js";

describe("COMPILE_ERROR_CODES", () => {
  it("giữ đủ 12 code của compiler M1", () => {
    expect(COMPILE_ERROR_CODES).toHaveLength(12);
    expect(COMPILE_ERROR_CODES).toContain("prereq_cycle");
    expect(COMPILE_ERROR_CODES).toContain("secret_ref_unknown");
  });

  it("thứ tự = dòng chảy phase 1→5, prereq_cycle đứng đầu", () => {
    expect(COMPILE_ERROR_CODES[0]).toBe("prereq_cycle");
  });
});

describe("compileDiagnosticSchema", () => {
  it("nhận diagnostic có stepOrdinal", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "verb_args_invalid",
      caseId: "checkout",
      stepOrdinal: 3,
      message: "thiếu param 'value'",
    });
    expect(r.success).toBe(true);
  });

  it("nhận diagnostic không stepOrdinal (lỗi cấp case)", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "prereq_cycle",
      caseId: "a",
      message: "cycle a→b→a",
    });
    expect(r.success).toBe(true);
  });

  it("từ chối code ngoài danh mục", () => {
    const r = compileDiagnosticSchema.safeParse({
      severity: "error",
      code: "kaboom",
      caseId: "a",
      message: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("runSchema", () => {
  const run = {
    id: "run-001",
    teamId: "team-acme",
    projectId: "proj-web-checkout",
    lane: "batch",
    status: "succeeded",
    verdict: "passed",
    planContentHash: "a".repeat(64),
    diagnostics: [],
  };

  it("nhận run passed", () => {
    expect(runSchema.parse(run).verdict).toBe("passed");
  });

  it("nhận run compile_error kèm diagnostics và KHÔNG có planContentHash", () => {
    const { planContentHash: _drop, ...noPlan } = run;
    const r = runSchema.safeParse({
      ...noPlan,
      status: "failed",
      verdict: "compile_error",
      diagnostics: [{ severity: "error", code: "unknown_verb", caseId: "a", message: "web.teleport" }],
    });
    expect(r.success).toBe(true);
  });

  it("từ chối planContentHash không phải sha256 hex 64 ký tự", () => {
    expect(runSchema.safeParse({ ...run, planContentHash: "deadbeef" }).success).toBe(false);
  });

  it("từ chối verdict lạ", () => {
    expect(runSchema.safeParse({ ...run, verdict: "flaky" }).success).toBe(false);
  });

  it("từ chối status lạ", () => {
    expect(runSchema.safeParse({ ...run, status: "queued" }).success).toBe(false);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/run.test.ts`
Expected: FAIL — không resolve được `./run.js`.

- [x] **Step 3: Viết implementation tối thiểu**

Tạo `testkite/packages/contract/src/schemas/run.ts`:

```ts
/**
 * DTO run + danh mục lỗi compile.
 *
 * `COMPILE_ERROR_CODES` SỐNG Ở ĐÂY chứ không ở run-compiler: contract không được
 * import run-compiler (ngược DAG), mà `runSchema` cần danh mục này. run-compiler
 * re-export lại — nó vốn phụ thuộc contract, nên chiều này là chiều xuôi duy nhất
 * giữ được MỘT danh sách.
 */
import { z } from "zod";
import { JOB_KINDS, JOB_STATUSES, LANES, RUN_VERDICTS } from "../index.js";

export const runVerdictSchema = z.enum(RUN_VERDICTS);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const jobKindSchema = z.enum(JOB_KINDS);
export const laneSchema = z.enum(LANES);

/**
 * DỮ LIỆU, không chỉ là type: golden suite của compiler duyệt mảng này lúc CHẠY
 * để chứng minh "mỗi code có ≥1 fixture âm". Thứ tự = dòng chảy phase 1→5.
 */
export const COMPILE_ERROR_CODES = [
  "prereq_cycle",
  "prereq_depth_exceeded",
  "prereq_missing",
  "step_group_depth_exceeded",
  "step_group_missing",
  "unknown_verb",
  "verb_args_invalid",
  "element_pending_locator",
  "element_not_found",
  "secret_ref_unknown",
  "while_without_max_iterations",
  "data_profile_empty",
] as const;

export type CompileErrorCode = (typeof COMPILE_ERROR_CODES)[number];

export const compileErrorCodeSchema = z.enum(COMPILE_ERROR_CODES);

export const compileDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: compileErrorCodeSchema,
  caseId: z.string().min(1),
  /** Vắng mặt = lỗi cấp case (prereq cycle...), không phải cấp step. */
  stepOrdinal: z.number().int().positive().optional(),
  message: z.string().min(1),
});

/** SHA-256 hex thường — khớp `contentHashOf` của phase 7. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const runSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  projectId: z.string().min(1),
  lane: laneSchema,
  status: jobStatusSchema,
  verdict: runVerdictSchema,
  /** Vắng mặt khi verdict=compile_error: không có plan thì không có hash. */
  planContentHash: contentHashSchema.optional(),
  diagnostics: z.array(compileDiagnosticSchema),
});

export interface CompileDiagnosticDto {
  severity: "error" | "warning";
  code: CompileErrorCode;
  caseId: string;
  stepOrdinal?: number | undefined;
  message: string;
}

export interface RunDto {
  id: string;
  teamId: string;
  projectId: string;
  lane: (typeof LANES)[number];
  status: (typeof JOB_STATUSES)[number];
  verdict: (typeof RUN_VERDICTS)[number];
  planContentHash?: string | undefined;
  diagnostics: CompileDiagnosticDto[];
}
```

Thêm vào `testkite/packages/contract/src/schemas/index.ts`:

```ts
export * from "./run.js";
```

- [x] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/schemas/run.test.ts`
Expected: PASS (10 test).

- [x] **Step 5: Dời danh mục khỏi run-compiler**

Trong `testkite/packages/run-compiler/src/index.ts`, XOÁ khối khai báo `COMPILE_ERROR_CODES` + `export type CompileErrorCode` (khoảng dòng 30–50, từ comment `Danh mục lỗi compile` tới hết `export type CompileErrorCode = ...`) và thay bằng:

```ts
/**
 * Danh mục lỗi compile SỐNG Ở `@testkite/contract` (biên API và compiler phải cùng
 * một danh sách; contract không import ngược được nên contract là bên sở hữu).
 * Re-export ở đây để mọi call-site cũ — kể cả golden suite — không phải đổi import.
 */
export { COMPILE_ERROR_CODES } from "@testkite/contract";
export type { CompileErrorCode } from "@testkite/contract";
```

- [x] **Step 6: Chạy TOÀN BỘ test, xác nhận không vỡ gì**

Run: `cd testkite && pnpm typecheck && pnpm test`
Expected: exit 0. Golden suite của run-compiler vẫn xanh — nó import `COMPILE_ERROR_CODES` từ `./index.js`, đường dẫn không đổi.

- [x] **Step 7: Commit**

```bash
git add testkite/packages/contract/src/schemas/run.ts testkite/packages/contract/src/schemas/run.test.ts testkite/packages/contract/src/schemas/index.ts testkite/packages/run-compiler/src/index.ts
git commit -m "M1 A4: contract zod schema run + dời COMPILE_ERROR_CODES về contract"
```

---

## Task A5 — Sinh OpenAPI 3.1 + commit `openapi.json`

**Files:**
- Create: `testkite/packages/contract/src/openapi.ts`
- Create: `testkite/packages/contract/src/openapi.gen.ts`
- Create: `testkite/packages/contract/openapi.json` (sinh ra, commit)
- Test: `testkite/packages/contract/src/openapi.test.ts`
- Modify: `testkite/packages/contract/package.json` (dep `zod-openapi`, devDep `tsx`, script `openapi:gen`)
- Modify: `testkite/packages/contract/src/index.ts` (re-export schemas + openapi)

**Interfaces:**
- Consumes: mọi schema từ `./schemas/index.js` (A1–A4).
- Produces: `buildOpenApiDocument(): oas31.OpenAPIObject`, `serializeOpenApiDocument(): string`, hằng `OPENAPI_SCHEMA_NAMES`. Task A6 gọi `serializeOpenApiDocument()` trong gate drift.

**Vì sao cần `tsx`:** entry `openapi.gen.ts` import `./openapi.js` trỏ tới `openapi.ts`. Type-stripping gốc của Node 22 KHÔNG ánh xạ `.js → .ts` — đã xác minh: `ERR_MODULE_NOT_FOUND: .../openapi.js`. `tsx` làm được. Đây là devDep của riêng package contract, không đụng runtime.

- [x] **Step 1: Thêm dependency**

```bash
cd testkite
pnpm -F @testkite/contract add zod-openapi@4.2.4 --save-exact
pnpm -F @testkite/contract add -D tsx@^4.23
```

Rồi thêm vào `scripts` của `testkite/packages/contract/package.json`:

```json
"openapi:gen": "tsx src/openapi.gen.ts"
```

Kiểm chứng peer khớp: `pnpm -F @testkite/contract why zod` phải cho `zod 3.25.76`, và `pnpm install` KHÔNG in cảnh báo peer nào cho `zod-openapi`.

- [x] **Step 2: Viết test ĐỎ**

Tạo `testkite/packages/contract/src/openapi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";

describe("buildOpenApiDocument", () => {
  it("là OpenAPI 3.1.0", () => {
    expect(buildOpenApiDocument().openapi).toBe("3.1.0");
  });

  it("đăng ký đủ mọi schema công bố", () => {
    const schemas = buildOpenApiDocument().components?.schemas ?? {};
    for (const name of OPENAPI_SCHEMA_NAMES) expect(Object.keys(schemas)).toContain(name);
  });

  it("literal dịch thành `const` — idiom 3.1, không phải enum 1 phần tử của 3.0", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: { kind: { const?: string; enum?: string[] } } }[];
    };
    const kinds = step.oneOf.map((b) => b.properties.kind.const);
    expect(kinds).toContain("action");
    expect(step.oneOf[0]?.properties.kind.enum).toBeUndefined();
  });

  it("children của block trỏ ngược về chính AuthoredStep ($ref đệ quy)", () => {
    const step = buildOpenApiDocument().components?.schemas?.["AuthoredStep"] as {
      oneOf: { properties: Record<string, { items?: { $ref?: string } }> }[];
    };
    const withChildren = step.oneOf.find((b) => b.properties["children"] !== undefined);
    expect(withChildren?.properties["children"]?.items?.$ref).toBe("#/components/schemas/AuthoredStep");
  });

  it("mọi $ref trong tài liệu đều trỏ tới một schema có thật", () => {
    const doc = buildOpenApiDocument();
    const names = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(names.has(ref as string)).toBe(true);
  });
});

describe("serializeOpenApiDocument", () => {
  it("sinh 2 lần ra byte GIỐNG HỆT — điều kiện sống của gate drift", () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
  });

  it("kết thúc bằng newline — POSIX, tránh diff giả ở dòng cuối", () => {
    expect(serializeOpenApiDocument().endsWith("\n")).toBe(true);
  });
});
```

- [x] **Step 3: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/openapi.test.ts`
Expected: FAIL — không resolve được `./openapi.js`.

- [x] **Step 4: Viết implementation tối thiểu**

Tạo `testkite/packages/contract/src/openapi.ts`:

```ts
/**
 * OpenAPI 3.1 SINH RA từ zod — zod là nguồn, file này chỉ là ống dẫn.
 *
 * Thư viện: `zod-openapi` pin exact 4.2.4. Bản mới nhất (6.x) đòi peer zod ^4;
 * 4.2.4 là bản cuối phủ trọn dải `zod: ^3.24.1` của workspace. Chọn nó thay
 * `@asteasolutions/zod-to-openapi` vì nó KHÔNG cần `extendZodWithOpenApi(z)` —
 * không vá prototype module `zod` dùng chung, nên nạp `@testkite/contract`
 * không đổi hành vi zod của `@testkite/run-compiler` (package phải PURE).
 *
 * M1 chỉ công bố CATALOG SCHEMA (`components.schemas`), chưa có `paths`:
 * chưa có route Fastify nào tồn tại, sinh path bây giờ là bịa tài liệu.
 * OpenAPI 3.1 cho phép thiếu `paths` (khác 3.0). M2 gắn route thật vào đây.
 */
import { createDocument } from "zod-openapi";
import type { oas31 } from "zod-openapi";
import {
  authoredCaseSchema,
  authoredStepSchema,
  compileDiagnosticSchema,
  dataProfileSchema,
  dataRowSchema,
  elementSchema,
  envSchema,
  locatorSchema,
  runSchema,
} from "./schemas/index.js";

/**
 * Thứ tự KHÔNG được đảo lung tung: nó là thứ tự key trong openapi.json commit,
 * mà gate drift so byte. Thêm schema mới thì THÊM VÀO CUỐI.
 */
export const OPENAPI_SCHEMA_NAMES = [
  "Locator",
  "Element",
  "AuthoredStep",
  "AuthoredCase",
  "DataRow",
  "DataProfile",
  "Env",
  "CompileDiagnostic",
  "Run",
] as const;

export const OPENAPI_INFO = {
  title: "TestKite Contract",
  version: "0.0.1",
  description:
    "Catalog schema authoring-facing của TestKite, sinh từ zod. M1: chỉ components.schemas — paths gắn ở M2 cùng route Fastify.",
} as const;

export function buildOpenApiDocument(): oas31.OpenAPIObject {
  return createDocument({
    openapi: "3.1.0",
    info: OPENAPI_INFO,
    components: {
      schemas: {
        Locator: locatorSchema,
        Element: elementSchema,
        AuthoredStep: authoredStepSchema,
        AuthoredCase: authoredCaseSchema,
        DataRow: dataRowSchema,
        DataProfile: dataProfileSchema,
        Env: envSchema,
        CompileDiagnostic: compileDiagnosticSchema,
        Run: runSchema,
      },
    },
  });
}

/** Dạng byte CHÍNH THỨC của spec: 2 space indent, newline cuối file. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
```

Tạo `testkite/packages/contract/src/openapi.gen.ts`:

```ts
/**
 * Entry regen spec. Chạy: `pnpm -F @testkite/contract openapi:gen`
 * (qua tsx — type-stripping gốc của Node 22 không ánh xạ `./x.js` → `x.ts`).
 *
 * Ghi ĐÈ vô điều kiện: `openapi.json` là ĐẦU RA, không phải file người sửa tay.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOpenApiDocument } from "./openapi.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(packageRoot, "openapi.json");
writeFileSync(target, serializeOpenApiDocument(), "utf8");
process.stdout.write(`openapi.json đã ghi: ${target}\n`);
```

Sửa `testkite/packages/contract/src/index.ts` — thêm vào CUỐI file:

```ts
// ---------------------------------------------------------------------------
// Schema DTO + OpenAPI (zod là nguồn, openapi.json là đầu ra)
// ---------------------------------------------------------------------------

export * from "./schemas/index.js";
export { buildOpenApiDocument, OPENAPI_INFO, OPENAPI_SCHEMA_NAMES, serializeOpenApiDocument } from "./openapi.js";
```

- [x] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm -F @testkite/contract exec vitest run src/openapi.test.ts`
Expected: PASS (7 test).

- [x] **Step 6: Sinh spec lần đầu và kiểm mắt thường**

```bash
cd testkite && pnpm -F @testkite/contract openapi:gen
head -20 packages/contract/openapi.json
```

Expected: dòng 2 là `"openapi": "3.1.0"`; có `"components"` với 9 key schema; KHÔNG có key `"paths"`.

- [x] **Step 7: Chạy toàn bộ + typecheck**

Run: `cd testkite && pnpm typecheck && pnpm test`
Expected: exit 0.

- [x] **Step 8: Commit**

```bash
git add testkite/packages/contract/package.json testkite/packages/contract/openapi.json testkite/packages/contract/src/openapi.ts testkite/packages/contract/src/openapi.gen.ts testkite/packages/contract/src/openapi.test.ts testkite/packages/contract/src/index.ts testkite/pnpm-lock.yaml
git commit -m "M1 A5: sinh OpenAPI 3.1 từ zod (zod-openapi 4.2.4) + commit spec"
```

---

## Task A6 — Gate drift: regen + `git diff --exit-code` (script + CI)

**Files:**
- Modify: `testkite/package.json` (scripts `openapi:gen`, `openapi:check`)
- Modify: `.github/workflows/testkite-ci.yml` (thêm bước sau bước Test)
- Test: `testkite/packages/run-compiler/src/contract-conformance.test.ts` (mới — corpus fixture thật chứng minh schema không lệch compiler)

**Interfaces:**
- Consumes: `openapi:gen` (A5), `compileSnapshotSchema` (A3), `COMPILE_ERROR_CODES` (A4).
- Produces: script `pnpm openapi:check` — regen rồi fail nếu cây làm việc bẩn ở `packages/contract/openapi.json`.

**Vì sao có test conformance:** schema contract và type snapshot của compiler là hai bản mô tả CÙNG một hình dạng. Cách rẻ và thật nhất để chứng minh chúng chưa lệch: bắt 20+ fixture authoring có sẵn của golden suite đi qua `compileSnapshotSchema`. Fixture là dữ liệu thật compiler đang ăn — nếu schema hẹp hơn thực tế, test đỏ ngay.

- [x] **Step 1: Viết test conformance ĐỎ**

Tạo `testkite/packages/run-compiler/src/contract-conformance.test.ts`:

```ts
/**
 * Chứng minh schema của `@testkite/contract` và type snapshot của compiler
 * chưa lệch nhau — bằng DỮ LIỆU THẬT: toàn bộ fixture của golden suite.
 *
 * Đây là test một chiều có chủ đích: mọi thứ compiler ăn được thì biên API
 * phải nhận. Chiều ngược (API nhận gì compiler cũng ăn) là việc của compiler.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSnapshotSchema } from "@testkite/contract";
import { describe, expect, it } from "vitest";
import { COMPILE_ERROR_CODES } from "./index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".golden.json"))
  .sort();

describe("contract ⇄ compiler conformance", () => {
  it("corpus fixture không rỗng (nếu rỗng thì test này vô nghĩa)", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtureFiles)("fixture %s: snapshot lọt compileSnapshotSchema", (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
    const snapshot = (raw as { snapshot: unknown }).snapshot;
    const result = compileSnapshotSchema.safeParse(snapshot);
    if (!result.success) {
      throw new Error(`${file} không qua schema contract:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });

  it("COMPILE_ERROR_CODES re-export từ contract, không phải bản sao cục bộ", async () => {
    const contract = await import("@testkite/contract");
    expect(COMPILE_ERROR_CODES).toBe(contract.COMPILE_ERROR_CODES);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận nó THẬT SỰ chạy (có thể ĐỎ)**

Run: `cd testkite && pnpm -F @testkite/run-compiler exec vitest run src/contract-conformance.test.ts`
Expected: chạy 33 test (31 fixture `.json` không phải `.golden.json`, + 2 test khung). Nếu fixture nào đỏ, đọc issue in ra rồi NỚI SCHEMA CHO ĐÚNG THỰC TẾ (ví dụ có fixture `targetCaseIds` rỗng, hoặc element không locator) — sửa file schema ở A1–A4, KHÔNG sửa fixture: fixture là hợp đồng đã chốt của compiler.

- [x] **Step 3: Thêm script gate vào workspace root**

Trong `scripts` của `testkite/package.json`, thêm:

```json
"openapi:gen": "pnpm -F @testkite/contract openapi:gen",
"openapi:check": "pnpm openapi:gen && git diff --exit-code -- packages/contract/openapi.json"
```

- [x] **Step 4: Chứng minh gate BẮT ĐƯỢC drift (đây là \"test\" của gate)**

```bash
cd testkite
# 1. Sạch thì phải xanh:
pnpm openapi:check; echo "clean -> $?"
# 2. Cố tình làm schema lệch khỏi spec commit:
sed -i 's/^    "Catalog schema authoring-facing/    "DRIFT PROBE Catalog schema authoring-facing/' packages/contract/src/openapi.ts
# 2b. CHỐT CỬA: probe không sửa được nguồn thì bước 2 chứng minh con số 0.
git diff --quiet -- packages/contract/src/openapi.ts && { echo "PROBE KHÔNG SỬA ĐƯỢC NGUỒN — dừng"; exit 9; }
pnpm openapi:check; echo "drifted -> $?"
# 3. Trả lại nguyên trạng:
git checkout -- packages/contract/src/openapi.ts packages/contract/openapi.json
pnpm openapi:check; echo "restored -> $?"
```

Expected: `clean -> 0`, `drifted -> 1` (kèm diff của `openapi.json` in ra), `restored -> 0`. Nếu `drifted -> 0` thì gate là đồ trang trí — dừng lại và sửa script trước khi đi tiếp.

> **Sửa lúc thực thi:** sed bản đầu (`'s/description: "Catalog schema…'`) KHÔNG khớp file thật — prettier ngắt `description:` và chuỗi thành hai dòng, nên probe là no-op và cho `drifted -> 0` (gate vô can). Đã đổi pattern sang neo dòng chuỗi + thêm bước 2b khẳng định probe thật sự sửa nguồn. Chạy lại: `clean -> 0`, `drifted -> 1` kèm diff `info.description`, `restored -> 0`.

- [x] **Step 5: Thêm bước vào CI**

Trong `.github/workflows/testkite-ci.yml`, chèn NGAY SAU bước `Test` (trước bước `Gate — no browser in API image`):

```yaml
      - name: Gate — OpenAPI spec drift (regen phải không đổi byte nào)
        working-directory: testkite
        run: pnpm openapi:check
```

- [x] **Step 6: Chạy toàn bộ**

Run: `cd testkite && pnpm typecheck && pnpm test && pnpm openapi:check`
Expected: exit 0 cả ba.

> **Kết quả A6:** conformance chạy 33 test và ĐỎ 3 — schema A1/A2 hẹp hơn thực tế fixture, đã NỚI SCHEMA (không đụng fixture) theo đúng chỉ dẫn Step 2:
> - `elementSchema.locators` bỏ `.min(1)` cứng, thay bằng `superRefine`: chỉ `status = ready` mới đòi ≥1 locator. `pending_locator` + `locators: []` là dữ liệu thật (`err-element-pending-locator.json`) và compiler mới là bên phát `element_pending_locator`.
> - `while.maxIterations` thành optional (`?: number | undefined`), khớp `AuthoredStep` của compiler (`maxIterations?: number`). `err-while-without-max-iterations.json` + `err-gather-all-not-first-fail.json` đòi compiler gom diagnostic một lượt; chặn 400 ở biên sẽ cắt mất lô đó.
> - Hai test cũ khẳng định độ chặt sai đã được viết lại (ĐỎ trước, code sau) và bổ sung test element `pending_locator` không locator.
> - `openapi.json` regen theo (mất `minItems: 1` ở `Element.locators`, mất `maxIterations` khỏi `required` của nhánh `while`) và commit cùng — chính gate đã bắt được drift này trước khi commit.
> - Đếm test sau A6: contract 55, run-compiler 178, verb-kit 12, apps/core 55 (+4 skip) — `pnpm typecheck`, `pnpm test`, `pnpm openapi:check` đều exit 0.

- [x] **Step 7: Commit**

```bash
git add testkite/package.json testkite/packages/run-compiler/src/contract-conformance.test.ts .github/workflows/testkite-ci.yml
git commit -m "M1 A6: gate CI drift OpenAPI + test conformance contract/compiler"
```

---

# PHẦN B — Toolchain hardening

## Task B1 — eslint flat config nền + `pnpm lint`

**Files:**
- Create: `testkite/eslint.config.mjs`
- Modify: `testkite/package.json` (devDeps + script `lint`)

**Interfaces:**
- Consumes: không.
- Produces: `testkite/eslint.config.mjs` với `export default [...]` (mảng flat config) — Task B2/B3 CHÈN THÊM block vào mảng này; script `pnpm lint`.

**Quyết định phiên bản (có bằng chứng, đừng đảo):**
- Brief nói "eslint 9". Nhưng `pnpm info eslint@9.39.5 deprecated` trả về `This version is no longer supported` — nhánh 9 đã hết vòng đời. Dùng **`eslint@^10.9`** (flat config y hệt về hình dạng). `eslint-plugin-boundaries@7.2.0` peer `eslint: >=6.0.0` ✅; `typescript-eslint@8.68.0` peer `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0` ✅ và `typescript: >=4.8.4 <6.1.0` (repo `~5.7.3`) ✅; engines eslint 10 = `^20.19 || ^22.13 || >=24` (repo Node 22) ✅.
- **`eslint-import-resolver-typescript` là BẮT BUỘC, không phải tuỳ chọn.** Repo dùng NodeNext nên import nội bộ viết `./foo.js` trỏ tới `foo.ts`. Không có resolver này thì `boundaries` phân giải dependency ra `null` và **âm thầm cho qua MỌI vi phạm** — đã dựng lại đúng lỗi đó trong spike (`"to": { "element": { "path": null, "isUnknown": true } }`, exit 0 dù file vi phạm rành rành).
- **M1 KHÔNG bật bộ rule style/recommended nào.** Phạm vi dòng checklist là luật KIẾN TRÚC. Bật `recommended` giờ là kéo vào một mớ vi phạm phải sửa không liên quan. Config nền đã được chạy thử trên chính repo này: **38 file, 0 message**.

- [x] **Step 1: Cài dependency**

```bash
cd testkite
pnpm add -Dw eslint@^10.9 typescript-eslint@^8.68 eslint-plugin-boundaries@^7.2 eslint-import-resolver-typescript@^4.4
```

- [x] **Step 2: Viết config nền**

Tạo `testkite/eslint.config.mjs`:

```js
/**
 * Flat config của TestKite. `.mjs` chứ không `.js`: workspace root không khai
 * `"type": "module"`, nên `.js` ở đây là CommonJS còn flat config bắt buộc ESM.
 *
 * M1 CHỈ cưỡng chế LUẬT KIẾN TRÚC, không luật style:
 *  - DAG một chiều giữa 12 module apps/core        (Task B2)
 *  - run-compiler PURE + queue chỉ trong kernel     (Task B3)
 * Rule style/recommended để dành — chúng kéo theo hàng loạt sửa vô can.
 *
 * `pnpm lint` chỉ soi `apps` và `packages`. `tools/lint-fixtures/**` cố ý VI PHẠM
 * và được test riêng gọi thẳng qua ESLint Node API (xem tools/lint-rules.test.ts).
 */
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
  },
];
```

- [x] **Step 3: Thêm script**

Trong `scripts` của `testkite/package.json`, thêm:

```json
"lint": "eslint apps packages"
```

- [x] **Step 4: Chạy lint, xác nhận XANH trên repo hiện tại**

Run: `cd testkite && pnpm lint`
Expected: exit 0, không in gì. Kiểm nó thật sự có đọc file (chứ không quét rỗng):

Run: `cd testkite && pnpm exec eslint apps packages -f json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('files:',JSON.parse(d).length))"`
Expected: `files: 38` (± vài file nếu task trước đã thêm).

> **Kết quả B1:** `pnpm lint` → exit 0, không in gì. Đếm file: **`files: 76`**, không phải 38 — con số 38 là ảnh chụp lúc spike, phần A đã thêm 9 file schema/openapi và các task kernel-db trước đó thêm phần còn lại. Đã đối chiếu: `git ls-files apps packages | grep -E '\.tsx?$' | wc -l` = **76**, khớp tuyệt đối ⇒ config phủ đúng mọi file nguồn, không lọt `dist/` hay `node_modules/` (repo chưa có thư mục `dist`, không có file `.ts` untracked).
>
> **Bằng chứng config sống (M1 nền chưa bật rule nào nên phải chứng minh gián tiếp):** tạo tạm `packages/contract/src/__lint_probe.ts` chứa cú pháp TS-only (`satisfies`, type annotation) + `debugger`.
> - Bơm rule qua CLI: `pnpm exec eslint packages/contract/src/__lint_probe.ts --rule '{"no-debugger":"error"}'` → **ĐỎ** `3:3 error Unexpected 'debugger' statement no-debugger`, exit 1 — rule đặt vào config này thật sự nổ trên đường lint chính.
> - Cùng file với config nền: exit 0 — đúng chủ trương "M1 không bật rule style".
> - Đối chứng ÂM (bỏ block parser TS): `--config` tạm chỉ có `files` → **ĐỎ** `1:12 error Parsing error: Unexpected token :` ⇒ block `languageOptions.parser` là load-bearing, không phải trang trí.
> - Xoá `__lint_probe.ts` sau khi đo; `git status` sạch, chỉ còn thay đổi có chủ đích.
>
> Phiên bản khoá thật trong lockfile: `eslint 10.9.1`, `typescript-eslint 8.68.0`, `eslint-plugin-boundaries 7.2.0`, `eslint-import-resolver-typescript 4.4.5`. Verify: `pnpm typecheck` exit 0, `pnpm test` exit 0 (300 pass + 4 skip concurrency), `pnpm lint` exit 0.

- [x] **Step 5: Commit**

```bash
git add testkite/eslint.config.mjs testkite/package.json testkite/pnpm-lock.yaml
git commit -m "M1 B1: eslint flat config nền + pnpm lint"
```

---

## Task B2 — `eslint-plugin-boundaries`: cưỡng chế DAG 12 module

**Files:**
- Create: `testkite/module-dag.json`
- Create: `testkite/tools/lint-fixtures/apps/core/src/modules/kernel/index.ts`
- Create: `testkite/tools/lint-fixtures/apps/core/src/modules/identity/index.ts`
- Create: `testkite/tools/lint-fixtures/apps/core/src/modules/results/index.ts`
- Create: `testkite/tools/lint-rules.test.ts`
- Create: `testkite/tools/module-dag.test.ts`
- Modify: `testkite/eslint.config.mjs` (thêm block boundaries)
- Modify: `testkite/package.json` (script `test:tools`; `test` gọi thêm nó)

**Interfaces:**
- Consumes: `eslint.config.mjs` (B1), `testkite/ownership.json`.
- Produces: `module-dag.json` (map `module → module[] được phép import`); helper test `lintFixture(relPath): Promise<string[]>` trả về danh sách ruleId — Task B3 tái dùng đúng helper này.

**DAG (blueprint §4):** `kernel → identity, governance → verbs | elements | testdata → authoring → planning → orchestration → results`; ba module rìa `integrations`, `ai`, `mcp-gateway` được import mọi thứ hướng vào trong, KHÔNG ai import chúng. Cạnh ngược/ngang không phải "xin phép" mà là domain event qua outbox — nên default của rule là `disallow`.

**Cách test luật lint (áp dụng cho cả B2 và B3):** file vi phạm mẫu sống thường trú ở `tools/lint-fixtures/`, gương lại đúng cấu trúc thư mục thật (`apps/core/src/modules/<tên>/`) để `boundaries` phân loại chúng đúng như file thật — đã xác minh: fixture ở `tools/lint-fixtures/apps/core/src/modules/kernel/index.ts` được phân loại là module `kernel`. `pnpm lint` không chạm tới chúng vì chỉ nhắm `apps packages`.

- [x] **Step 1: Viết test ĐỎ**

Tạo `testkite/tools/lint-rules.test.ts`:

```ts
/**
 * Luật lint cũng là code — nên nó cũng có test.
 *
 * Fixture ở `tools/lint-fixtures/` gương lại đúng cấu trúc thư mục thật để
 * eslint-plugin-boundaries phân loại chúng y như file production. `pnpm lint`
 * chỉ nhắm `apps packages` nên không bao giờ chạm vào chúng; test này gọi
 * thẳng ESLint Node API.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: workspaceRoot });

async function lintFixture(relPath: string): Promise<string[]> {
  const results = await eslint.lintFiles([join(workspaceRoot, "tools", "lint-fixtures", relPath)]);
  const first = results[0];
  if (first === undefined) throw new Error(`ESLint không trả kết quả nào cho ${relPath}`);
  return first.messages.map((m) => m.ruleId ?? "<no-rule>");
}

describe("DAG 12 module (boundaries/dependencies)", () => {
  it("BẮT import ngược DAG: kernel → identity", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/dag-backward.ts")).toContain("boundaries/dependencies");
  });

  it("CHO QUA import xuôi DAG: results → planning", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-forward.ts")).toEqual([]);
  });

  it("BẮT import module rìa từ lõi: results → ai", async () => {
    expect(await lintFixture("apps/core/src/modules/results/dag-edge-inward.ts")).toContain(
      "boundaries/dependencies",
    );
  });
});
```

Tạo `testkite/tools/module-dag.test.ts`:

```ts
/**
 * `module-dag.json` và `ownership.json` mô tả CÙNG bộ 12 module. Thêm module vào
 * một file mà quên file kia = một module không có luật lint nào canh, im lặng
 * suốt đời. Test này biến sự im lặng đó thành đỏ.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** Cả hai file đều mang khoá `$comment` làm tài liệu — lọc ra trước mọi so sánh. */
const stripComments = (o: Record<string, unknown>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("$"))) as Record<string, string[]>;

const dag = stripComments(require("../module-dag.json") as Record<string, unknown>);
const ownership = stripComments(require("../ownership.json") as Record<string, unknown>);

describe("module-dag.json", () => {
  it("cùng bộ key với ownership.json", () => {
    expect(Object.keys(dag).sort()).toEqual(Object.keys(ownership).sort());
  });

  it("đúng 12 module", () => {
    expect(Object.keys(dag)).toHaveLength(12);
  });

  it("mọi đích được phép đều là module có thật", () => {
    const names = new Set(Object.keys(dag));
    for (const [from, allowed] of Object.entries(dag)) {
      for (const to of allowed) expect(names.has(to), `${from} → ${to} không tồn tại`).toBe(true);
    }
  });

  it("không module nào tự import chính mình trong danh sách allow", () => {
    for (const [from, allowed] of Object.entries(dag)) expect(allowed).not.toContain(from);
  });

  it("là DAG THẬT — quan hệ allow không có chu trình", () => {
    // Chu trình tồn tại khi có cặp A allow B và B allow A (hoặc dài hơn).
    const reach = new Map<string, Set<string>>();
    const walk = (n: string, seen: Set<string>): Set<string> => {
      const cached = reach.get(n);
      if (cached !== undefined) return cached;
      const out = new Set<string>();
      for (const next of dag[n] ?? []) {
        expect(seen.has(next), `chu trình qua ${n} → ${next}`).toBe(false);
        out.add(next);
        for (const deep of walk(next, new Set([...seen, next]))) out.add(deep);
      }
      reach.set(n, out);
      return out;
    };
    for (const n of Object.keys(dag)) walk(n, new Set([n]));
  });

  it("kernel là gốc — không được phép import module nào", () => {
    expect(dag["kernel"]).toEqual([]);
  });

  it("module rìa không bao giờ là đích của module lõi", () => {
    const edge = ["integrations", "ai", "mcp-gateway"];
    for (const [from, allowed] of Object.entries(dag)) {
      if (edge.includes(from)) continue;
      for (const e of edge) expect(allowed, `${from} không được import ${e}`).not.toContain(e);
    }
  });
});
```

- [x] **Step 2: Nối `tools/` vào `pnpm test`, rồi chạy test xác nhận ĐỎ**

**Không có `testkite/vitest.config.ts`** — mỗi package tự chạy `vitest run` qua `pnpm -r test`, mà `tools/` không phải package trong workspace (`pnpm-workspace.yaml` chỉ có `apps/*` và `packages/*`). Không nối thêm thì hai file test vừa viết KHÔNG BAO GIỜ chạy trong CI.

Cách rẻ nhất và đã kiểm chứng: chạy vitest thẳng ở workspace root cho riêng thư mục `tools`. `vitest` và `eslint` đều là devDependency của root nên phân giải được từ đó.

Sửa `scripts` trong `testkite/package.json`:

```json
"test": "pnpm -r test && pnpm test:tools",
"test:tools": "vitest run tools"
```

Run: `cd testkite && pnpm test:tools`
Expected: FAIL — `Cannot find module '../module-dag.json'` và fixture chưa tồn tại.

- [x] **Step 3: Khai DAG dạng dữ liệu**

Tạo `testkite/module-dag.json`:

```json
{
  "$comment": "DAG một chiều 12 module (docs/SYSTEM_DESIGN.md §4). Key = module, value = các module nó ĐƯỢC PHÉP import. Cạnh ngược/ngang KHÔNG có ngoại lệ — dùng domain event qua krn_outbox. eslint-plugin-boundaries đọc file này; tools/module-dag.test.ts giữ nó đồng bộ với ownership.json.",
  "kernel": [],
  "identity": ["kernel"],
  "governance": ["kernel"],
  "verbs": ["kernel", "identity", "governance"],
  "elements": ["kernel", "identity", "governance"],
  "testdata": ["kernel", "identity", "governance"],
  "authoring": ["kernel", "identity", "governance", "verbs", "elements", "testdata"],
  "planning": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring"],
  "orchestration": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring", "planning"],
  "results": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring", "planning", "orchestration"],
  "integrations": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring", "planning", "orchestration", "results"],
  "ai": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring", "planning", "orchestration", "results"],
  "mcp-gateway": ["kernel", "identity", "governance", "verbs", "elements", "testdata", "authoring", "planning", "orchestration", "results"]
}
```

Trong `tools/module-dag.test.ts`, `$comment` bị loại bởi bộ lọc `startsWith("$")` — nhưng `Object.keys(dag)` trong các test khác thì không. Sửa dòng đọc file cho khớp:

```ts
const rawDag = require("../module-dag.json") as Record<string, unknown>;
const dag = Object.fromEntries(
  Object.entries(rawDag).filter(([k]) => !k.startsWith("$")),
) as Record<string, string[]>;
```

- [x] **Step 4: Thêm block boundaries vào config**

Trong `testkite/eslint.config.mjs`, thêm import ở đầu file:

```js
import { createRequire } from "node:module";
import boundaries from "eslint-plugin-boundaries";

const require = createRequire(import.meta.url);
const MODULE_DAG = Object.fromEntries(
  Object.entries(require("./module-dag.json")).filter(([name]) => !name.startsWith("$")),
);
```

và CHÈN block sau vào mảng `export default [...]`, ngay sau block parser:

```js
  {
    /**
     * Glob mở đầu `**` có chủ đích: nó khớp CẢ file production
     * (`apps/core/src/modules/...`) LẪN fixture (`tools/lint-fixtures/apps/core/src/modules/...`),
     * nên fixture được phân loại y hệt file thật và test luật lint mới có nghĩa.
     */
    files: ["**/apps/core/src/modules/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["**/apps/core/src/modules/**/*.ts"],
      /**
       * BẮT BUỘC. Repo dùng NodeNext: import nội bộ viết `./foo.js` trỏ tới `foo.ts`.
       * Thiếu resolver này, boundaries phân giải dependency ra null và CHO QUA
       * mọi vi phạm trong im lặng — tệ hơn không có lint.
       */
      "import/resolver": { typescript: { project: "./tsconfig.base.json" } },
      "boundaries/elements": [{ type: "module", pattern: "apps/core/src/modules/*", capture: ["name"] }],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "DAG vi phạm: module '{{from.captured.name}}' không được import '{{to.captured.name}}'. Cạnh ngược/ngang đi bằng domain event qua krn_outbox, không phải import (docs/SYSTEM_DESIGN.md §4).",
          policies: Object.entries(MODULE_DAG).map(([name, allowed]) => ({
            from: { element: { type: "module", captured: { name } } },
            allow: allowed.map((target) => ({ to: { element: { type: "module", captured: { name: target } } } })),
          })),
        },
      ],
    },
  },
```

**Cú pháp là của boundaries v7, không phải v5/v6.** Dùng `boundaries/dependencies` (không phải `element-types` đã đổi tên), `policies` (không phải `rules`), selector dạng object `{ element: { type, captured } }` (không phải tuple `["module", {...}]`), template `{{...}}` (không phải `${...}`). Sai cú pháp cũ vẫn chạy nhưng in warning và **không bắt gì cả**.

- [x] **Step 5: Tạo fixture**

`testkite/tools/lint-fixtures/apps/core/src/modules/identity/index.ts`:

```ts
export const MODULE = "identity" as const;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/planning/index.ts`:

```ts
export const MODULE = "planning" as const;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/ai/index.ts`:

```ts
export const MODULE = "ai" as const;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/kernel/dag-backward.ts`:

```ts
/** VI PHẠM CÓ CHỦ ĐÍCH: kernel là gốc DAG, không được import module nào. */
import { MODULE } from "../identity/index.js";

export const backward = MODULE;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/results/dag-forward.ts`:

```ts
/** HỢP LỆ: results ở cuối DAG, được import planning. */
import { MODULE } from "../planning/index.js";

export const forward = MODULE;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/results/dag-edge-inward.ts`:

```ts
/** VI PHẠM CÓ CHỦ ĐÍCH: ai là module rìa — lõi không bao giờ import rìa. */
import { MODULE } from "../ai/index.js";

export const edgeInward = MODULE;
```

- [x] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm test:tools`
Expected: PASS — 3 test lint-rules + 7 test module-dag.

- [x] **Step 7: `pnpm lint` vẫn phải XANH (fixture không được lọt vào đường lint chính)**

Run: `cd testkite && pnpm lint`
Expected: exit 0, không in gì. Nếu nó báo lỗi ở `tools/lint-fixtures/...` nghĩa là script `lint` đang quét quá rộng — script phải là `eslint apps packages`, không phải `eslint .`.

> **Kết quả B2:** `pnpm test:tools` → 10 pass (3 lint-rules + 7 module-dag). `pnpm lint` → exit 0; đếm file `eslint apps packages -f json` = **76 file, 0 file fixture** ⇒ fixture nằm ngoài đường lint chính đúng thiết kế. Toàn workspace: **310 pass + 4 skip** (nền 300 + 10 test mới), `pnpm typecheck` exit 0.
>
> **Sửa spec — DAG có 13 module, không phải 12.** Test `toHaveLength(12)` trong plan ĐỎ thật: `module-dag.json` và `ownership.json` đều 13 khoá. Đếm lại `docs/SYSTEM_DESIGN.md` §4: nhãn "12 module" đứng ngay trước danh sách liệt kê **13 tên** (kernel, identity, governance, verbs, elements, testdata, authoring, planning, orchestration, results + rìa integrations, ai, mcp). `ownership.json` đã commit từ trước là nguồn có thẩm quyền và nằm ngoài scope sửa ⇒ chốt assertion về **13** kèm comment giải thích "12 module" là TÊN GỌI chứ không phải phép đếm. Test `cùng bộ key với ownership.json` vẫn là tripwire chính.
>
> **Bắt được VI PHẠM THẬT có sẵn trong src (không phải fixture):** ngay lần chạy `pnpm lint` đầu tiên, rule nổ ở `apps/core/src/modules/kernel/db/tenant.ts:5` — `import { APP_ROLE } from "../../identity/index.js"`. Comment tại chỗ cho thấy nguyên nhân: tác giả đọc mũi tên `kernel → identity` của §4 là "kernel được import identity", trong khi `module-dag.json` chốt `"kernel": []` — kernel là GỐC, mũi tên chỉ chiều "identity được import kernel". Sửa TỐI THIỂU: dời cặp `APP_ROLE`/`appRole` từ `identity/db/schema.ts` sang `kernel/db/schema.ts` — đúng chỗ, vì nó là song sinh của `RELAY_ROLE`/`relayRole` đã sống sẵn ở đó và `kernel/db/tenant.ts` cần nó để `SET LOCAL ROLE`. Kernel facade export thêm 4 tên; `identity/db/schema.ts` và `authoring/db/schema.ts` lấy `appRole` từ facade kernel (cạnh XUÔI hợp lệ). Không đổi hành vi: chuỗi role vẫn `testkite_app`, glob drizzle `./src/modules/*/db/schema.ts` vẫn phủ cả hai file nên bề mặt schema không đổi, 55 test apps/core (gồm `test/schema/rls.test.ts` và `test/arch/module-boundaries.test.ts`) vẫn xanh.
>
> **Chứng minh luật bắt được vi phạm (luật cứng "test đỏ" của lint config):**
> - Fixture thường trú: `kernel/dag-backward.ts` (ngược DAG) và `results/dag-edge-inward.ts` (lõi → rìa `ai`) đều ĐỎ `boundaries/dependencies`; `results/dag-forward.ts` (results → planning) XANH.
> - Trên ĐƯỜNG LINT THẬT: tạo tạm `apps/core/src/modules/kernel/__dag_probe.ts` import từ identity → `pnpm lint` ĐỎ, exit 1, message đúng bản DAG. Xoá sau khi đo.
> - **Đối chứng âm cho `eslint-import-resolver-typescript`** (bẫy đã spike): copy config bỏ đúng khoá `import/resolver`, lint lại chính file `dag-backward.ts` → **exit 0, IM LẶNG CHO QUA**; config thật → exit 1. Resolver là load-bearing, không phải trang trí.
> - Cú pháp boundaries v7 xác nhận chạy đúng: `boundaries/dependencies` + `policies` + selector object + template `{{from.captured.name}}` render ra tên module thật trong message, không có warning deprecation.

- [x] **Step 8: Commit**

```bash
git add testkite/module-dag.json testkite/eslint.config.mjs testkite/package.json testkite/tools/
git commit -m "M1 B2: eslint-boundaries cưỡng chế DAG 12 module + test luật lint"
```

---

## Task B3 — Luật import: compiler PURE + queue chỉ trong kernel

**Files:**
- Modify: `testkite/eslint.config.mjs` (thêm 2 block)
- Create: `testkite/tools/lint-fixtures/packages/run-compiler/src/pure-ok.ts`
- Create: `testkite/tools/lint-fixtures/packages/run-compiler/src/pure-violations.ts`
- Create: `testkite/tools/lint-fixtures/packages/run-compiler/src/pure-ok.test.ts`
- Create: `testkite/tools/lint-fixtures/apps/core/src/modules/orchestration/queue-outside-kernel.ts`
- Create: `testkite/tools/lint-fixtures/apps/core/src/modules/kernel/queue-allowed.ts`
- Modify: `testkite/tools/lint-rules.test.ts` (thêm 2 describe)

**Interfaces:**
- Consumes: helper `lintFixture` từ B2.
- Produces: không có API mới — chỉ luật.

**Ranh giới phải chính xác, không nới không siết:**
- `node:crypto` **ĐƯỢC PHÉP** — `phase67-freeze.ts` băm SHA-256 bằng `createHash`. Cấm nó là gãy compiler.
- `*.test.ts` trong run-compiler **ĐƯỢC PHÉP** dùng `node:fs` — `golden.test.ts` đọc 20+ fixture bằng `readFileSync`. Không có `ignores` này thì task đầu tiên đã đỏ oan.
- `bullmq`/`ioredis` chỉ được xuất hiện trong `apps/core/src/modules/kernel/**` (M1 checklist: "lint cấm `bullmq` ngoài kernel").

- [ ] **Step 1: Viết test ĐỎ**

Thêm vào `testkite/tools/lint-rules.test.ts`:

```ts
describe("run-compiler PURE (no-restricted-*)", () => {
  it("CHO QUA node:crypto — phase 7 băm SHA-256 bằng createHash", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.ts")).toEqual([]);
  });

  it("BẮT node:fs", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-imports");
  });

  it("BẮT Date.now và Math.random", async () => {
    const ids = await lintFixture("packages/run-compiler/src/pure-violations.ts");
    expect(ids.filter((r) => r === "no-restricted-properties").length).toBeGreaterThanOrEqual(2);
  });

  it("BẮT process", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-violations.ts")).toContain("no-restricted-globals");
  });

  it("CHO QUA node:fs trong *.test.ts — golden suite đọc fixture bằng readFileSync", async () => {
    expect(await lintFixture("packages/run-compiler/src/pure-ok.test.ts")).toEqual([]);
  });
});

describe("queue chỉ trong kernel", () => {
  it("BẮT bullmq trong orchestration", async () => {
    expect(await lintFixture("apps/core/src/modules/orchestration/queue-outside-kernel.ts")).toContain(
      "no-restricted-imports",
    );
  });

  it("CHO QUA bullmq trong kernel", async () => {
    expect(await lintFixture("apps/core/src/modules/kernel/queue-allowed.ts")).toEqual([]);
  });
});
```

- [ ] **Step 2: Tạo fixture, chạy test, xác nhận ĐỎ**

`testkite/tools/lint-fixtures/packages/run-compiler/src/pure-ok.ts`:

```ts
/** HỢP LỆ: node:crypto là I/O-free, phase 7 cần nó để băm plan. */
import { createHash } from "node:crypto";

export function hashOf(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
```

`testkite/tools/lint-fixtures/packages/run-compiler/src/pure-violations.ts`:

```ts
/** VI PHẠM CÓ CHỦ ĐÍCH — bốn kiểu phá purity trong một file. */
import { readFileSync } from "node:fs";

export const readIt = readFileSync;
export const stamp = Date.now();
export const jitter = Math.random();
export const fromEnv = process.env["TESTKITE_BASE_URL"];
```

`testkite/tools/lint-fixtures/packages/run-compiler/src/pure-ok.test.ts`:

```ts
/** HỢP LỆ: test được đọc file — golden suite sống bằng readFileSync. */
import { readFileSync } from "node:fs";

export const readFixture = (p: string): string => readFileSync(p, "utf8");
```

`testkite/tools/lint-fixtures/apps/core/src/modules/orchestration/queue-outside-kernel.ts`:

```ts
/** VI PHẠM CÓ CHỦ ĐÍCH: BullMQ chỉ được xuất hiện trong kernel. */
import { Queue } from "bullmq";

export const q = Queue;
```

`testkite/tools/lint-fixtures/apps/core/src/modules/kernel/queue-allowed.ts`:

```ts
/** HỢP LỆ: kernel là nơi duy nhất chạm BullMQ (relay + dispatcher). */
import { Queue } from "bullmq";

export const q = Queue;
```

Run: `cd testkite && pnpm exec vitest run tools/lint-rules.test.ts`
Expected: FAIL — các test PURE/queue đỏ (luật chưa tồn tại), 3 test DAG của B2 vẫn xanh.

Nếu ESLint kêu không phân giải được `bullmq` — kệ, `no-restricted-imports` khớp trên CHUỖI import, không cần package tồn tại.

- [ ] **Step 3: Thêm 2 block vào config**

CHÈN vào cuối mảng `export default [...]` trong `testkite/eslint.config.mjs`:

```js
  {
    /**
     * Compiler PURE (CLAUDE.md Luật 4): cùng input ⇒ cùng content hash, mãi mãi.
     * `node:crypto` KHÔNG bị cấm — phase 7 băm bằng `createHash`, đó là tính toán
     * thuần. `*.test.ts` được miễn: golden.test.ts đọc 20+ fixture bằng node:fs.
     */
    files: ["**/packages/run-compiler/src/**/*.ts"],
    ignores: ["**/packages/run-compiler/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "fs", "node:fs", "node:fs/*",
                "net", "node:net", "node:dns", "node:tls",
                "http", "https", "node:http", "node:https",
                "node:child_process", "node:worker_threads", "node:cluster",
                "node:os", "node:process", "node:path", "node:url",
                "node:timers", "node:timers/*",
              ],
              message:
                "run-compiler phải PURE: cấm fs/net/process/timer. node:crypto được phép (hash phase 7). Việc đọc dữ liệu thuộc orchestration — compiler chỉ nhận snapshot đã fetch.",
            },
            {
              group: [
                "pg", "pg-*", "postgres",
                "drizzle-orm", "drizzle-orm/*", "drizzle-kit",
                "bullmq", "bullmq/*", "ioredis", "ioredis/*",
                "@testkite/core", "@testkite/core/*",
              ],
              message:
                "run-compiler phải PURE: cấm db/queue/app. Compiler là hàm, không phải service.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "run-compiler phải PURE: env đi vào qua EnvSnapshot, không qua process.env." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "run-compiler phải PURE: Date.now() làm content hash trôi giữa hai lần compile." },
        { object: "Math", property: "random", message: "run-compiler phải PURE: Math.random() làm content hash trôi giữa hai lần compile." },
      ],
    },
  },
  {
    /**
     * BullMQ/Valkey chỉ sống trong kernel (relay + dispatcher). Module khác muốn
     * phát việc thì ghi outbox trong cùng transaction, không tự cầm queue client.
     */
    files: ["**/apps/core/src/modules/**/*.ts"],
    ignores: ["**/apps/core/src/modules/kernel/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bullmq", "bullmq/*", "ioredis", "ioredis/*"],
              message:
                "Queue client chỉ được import trong modules/kernel. Module khác phát việc bằng cách ghi krn_outbox trong cùng transaction (docs/SYSTEM_DESIGN.md §4).",
            },
          ],
        },
      ],
    },
  },
```

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm test:tools`
Expected: PASS — 10 test lint-rules + 7 test module-dag.

- [ ] **Step 5: `pnpm lint` phải XANH trên code thật**

Run: `cd testkite && pnpm lint`
Expected: exit 0. `phase67-freeze.ts` import `node:crypto` — nếu nó bị bắt thì `node:crypto` đã lọt vào danh sách cấm, gỡ ra. `golden.test.ts` import `node:fs` — nếu nó bị bắt thì `ignores` của block PURE sai glob.

- [ ] **Step 6: Commit**

```bash
git add testkite/eslint.config.mjs testkite/tools/
git commit -m "M1 B3: lint cưỡng chế compiler PURE + queue chỉ trong kernel"
```

---

## Task B4 — `madge --circular` cho apps + packages

**Files:**
- Create: `testkite/.madgerc`
- Modify: `testkite/package.json` (devDep `madge`, script `lint:cycles`)
- Modify: `testkite/tools/lint-rules.test.ts` — KHÔNG sửa (madge không phải luật eslint)

**Interfaces:**
- Consumes: `testkite/tsconfig.base.json`.
- Produces: script `pnpm lint:cycles`.

**Phát hiện đã xác minh, đọc trước khi làm:** chạy `madge --circular` trần trên repo HIỆN TẠI báo **4 vòng lặp** trong `packages/run-compiler` (`index.ts ↔ phase1-chains.ts`, `↔ phase2-expand.ts`, `↔ phase3-bind.ts`, `↔ phase45-resolve.ts`). Cả bốn đều là **`import type` thuần** (các phase import `type { CompileDiagnostic } from "./index.js"`) — TypeScript xoá sạch lúc biên dịch, runtime không có vòng nào. Bật `detectiveOptions.ts.skipTypeImports` là hết cả bốn, đã chạy thử: `✔ No circular dependency found!`.

Đây là lựa chọn có ý thức: gate canh **vòng lặp giá trị lúc chạy**, không canh vòng lặp kiểu lúc biên dịch. Đổi lại thì `pnpm lint:cycles` sẽ đỏ ngay từ ngày đầu vì kiến trúc hiện tại và không ai chạy nó nữa.

- [ ] **Step 1: Cài madge**

```bash
cd testkite && pnpm add -Dw madge@^8
```

`madge@8.0.0` peer `typescript: ^5.4.4` — repo `~5.7.3` ✅.

- [ ] **Step 2: Chạy TRẦN trước để tận mắt thấy 4 vòng giả**

Run: `cd testkite && pnpm exec madge --circular --extensions ts --ts-config tsconfig.base.json packages/*/src apps/*/src`
Expected: `✖ Found 4 circular dependencies!` liệt kê `index.ts > phase*.ts`. Đây là baseline — nhìn nó rồi mới hiểu vì sao cần `.madgerc`.

- [ ] **Step 3: Viết `.madgerc`**

Tạo `testkite/.madgerc`:

```json
{
  "$comment": "skipTypeImports: gate này canh VÒNG LẶP GIÁ TRỊ LÚC CHẠY. Các phase compiler import `type { CompileDiagnostic } from './index.js'` — TypeScript xoá sạch lúc biên dịch nên runtime không có vòng nào; không bật cờ này thì madge báo 4 vòng giả và gate thành đồ trang trí.",
  "fileExtensions": ["ts", "tsx"],
  "tsConfig": "tsconfig.base.json",
  "detectiveOptions": {
    "ts": { "skipTypeImports": true },
    "tsx": { "skipTypeImports": true }
  }
}
```

- [ ] **Step 4: Thêm script**

Trong `scripts` của `testkite/package.json`:

```json
"lint:cycles": "madge --circular --no-spinner packages/*/src apps/*/src"
```

- [ ] **Step 5: Chạy lại, xác nhận XANH**

Run: `cd testkite && pnpm lint:cycles`
Expected: `✔ No circular dependency found!`, exit 0.

- [ ] **Step 6: Chứng minh gate BẮT ĐƯỢC vòng thật (đây là \"test\" của nó)**

```bash
cd testkite
cat > packages/run-compiler/src/cycle-probe-a.ts <<'PROBE'
import { b } from "./cycle-probe-b.js";
export const a = (): number => b() + 1;
PROBE
cat > packages/run-compiler/src/cycle-probe-b.ts <<'PROBE'
import { a } from "./cycle-probe-a.js";
export const b = (): number => (a === undefined ? 0 : 1);
PROBE
pnpm lint:cycles; echo "with-cycle -> $?"
rm packages/run-compiler/src/cycle-probe-a.ts packages/run-compiler/src/cycle-probe-b.ts
pnpm lint:cycles; echo "restored -> $?"
```

Expected: `with-cycle -> 1` kèm `✖ Found 1 circular dependency!`; `restored -> 0`. Nếu `with-cycle -> 0` thì `skipTypeImports` đang nuốt cả import giá trị — dừng lại và sửa.

- [ ] **Step 7: Commit**

```bash
git add testkite/.madgerc testkite/package.json testkite/pnpm-lock.yaml
git commit -m "M1 B4: madge --circular cho apps + packages"
```

---

## Task B5 — Nối lint + madge vào CI

**Files:**
- Modify: `.github/workflows/testkite-ci.yml`

**Interfaces:**
- Consumes: `pnpm lint` (B1–B3), `pnpm lint:cycles` (B4), `pnpm openapi:check` (A6).
- Produces: pipeline CI đầy đủ 6 gate.

- [ ] **Step 1: Sửa workflow**

Ghi đè `.github/workflows/testkite-ci.yml` thành (đây là trạng thái CUỐI, đã gồm bước drift của Task A6):

```yaml
name: TestKite CI

on:
  push:
    paths:
      - 'testkite/**'
      - '.github/workflows/testkite-ci.yml'
  pull_request:
    paths:
      - 'testkite/**'
      - '.github/workflows/testkite-ci.yml'

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Enable corepack
        run: corepack enable

      - name: Setup Node 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Prepare pnpm 9 via corepack
        run: corepack prepare pnpm@9 --activate

      - name: pnpm install (frozen lockfile)
        working-directory: testkite
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        working-directory: testkite
        run: pnpm typecheck

      - name: Test
        working-directory: testkite
        run: pnpm test

      - name: Gate — OpenAPI spec drift (regen phải không đổi byte nào)
        working-directory: testkite
        run: pnpm openapi:check

      - name: Gate — kiến trúc (DAG 12 module, compiler PURE, queue chỉ trong kernel)
        working-directory: testkite
        run: pnpm lint

      - name: Gate — không phụ thuộc vòng
        working-directory: testkite
        run: pnpm lint:cycles

      - name: Gate — no browser in API image (apps/core must stay browser-free)
        run: |
          grep -rE "playwright|puppeteer|chromium" testkite/apps/core/src --include='*.ts' && exit 1 || true
```

Hai đường `paths` được thêm chính file workflow: sửa gate mà gate không chạy là cách êm ái nhất để ship một gate hỏng.

- [ ] **Step 2: Chạy tại chỗ đúng thứ tự CI**

```bash
cd testkite
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm openapi:check && pnpm lint && pnpm lint:cycles
echo "ALL GATES -> $?"
```

Expected: `ALL GATES -> 0`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/testkite-ci.yml
git commit -m "M1 B5: nối gate lint + madge vào CI"
```

---

## Task B6 — Tick checklist M1

**Files:**
- Modify: `testkite/tasks/M1-kernel-contracts-compiler.md:8-13`

- [ ] **Step 1: Lấy hash của các commit vừa tạo**

Run: `git log --oneline -12`

- [ ] **Step 2: Tick hai dòng**

Trong `testkite/tasks/M1-kernel-contracts-compiler.md`, đổi:

```markdown
- [ ] `pnpm install` + toolchain: tsconfig refs, eslint (+ eslint-boundaries theo `ownership.json`,
      madge --circular, lint cấm `bullmq` ngoài kernel), vitest, CI cơ bản (typecheck + test mỗi PR)
```

thành (thay `<hash-B1>` … bằng hash thật, 7 ký tự):

```markdown
- [x] `pnpm install` + toolchain: tsconfig refs, eslint (+ eslint-boundaries theo `ownership.json`,
      madge --circular, lint cấm `bullmq` ngoài kernel), vitest, CI cơ bản (typecheck + test mỗi PR)
      (hash: <hash-B1>, <hash-B2>, <hash-B3>, <hash-B4>, <hash-B5>)
```

và đổi:

```markdown
- [ ] **contract:** zod schemas cho case/step/element/run + sinh OpenAPI 3.1, commit spec,
      CI fail khi regen drift
```

thành:

```markdown
- [x] **contract:** zod schemas cho case/step/element/run + sinh OpenAPI 3.1, commit spec,
      CI fail khi regen drift — `zod-openapi@4.2.4` (pin exact; xem plan để biết vì sao không
      dùng `@asteasolutions/zod-to-openapi`) (hash: <hash-A1>…<hash-A6>)
```

- [ ] **Step 3: Commit**

```bash
git add testkite/tasks/M1-kernel-contracts-compiler.md
git commit -m "M1: tick checklist contract/OpenAPI + toolchain"
```

---

## Exit criteria

Chạy được trọn chuỗi, exit 0 mỗi bước:

```bash
cd testkite && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm openapi:check && pnpm lint && pnpm lint:cycles
```

Và bốn khẳng định phải đúng — mỗi cái có một lệnh chứng minh, không phải niềm tin:

1. **Spec là đầu ra thật, không phải file chép tay.** Sửa một schema zod rồi chạy `pnpm openapi:check` ⇒ exit 1 kèm diff. Trả lại ⇒ exit 0.
2. **DAG được cưỡng chế, không chỉ được ghi trong comment.** `pnpm exec vitest run tools/lint-rules.test.ts` xanh, gồm test khẳng định `kernel → identity` BỊ BẮT và `results → planning` ĐƯỢC QUA.
3. **Compiler còn PURE bằng công cụ, không bằng thiện chí.** Cùng file test trên khẳng định `node:fs`/`Date.now`/`Math.random`/`process` bị bắt trong `run-compiler/src`, còn `node:crypto` và `*.test.ts` thì không.
4. **Schema contract chưa lệch compiler.** `pnpm -F @testkite/run-compiler exec vitest run src/contract-conformance.test.ts` — cả 20+ fixture authoring của golden suite parse lọt `compileSnapshotSchema`.

## Không thuộc phạm vi plan này (có chủ đích)

- **`paths` trong OpenAPI** — chưa có route Fastify nào để mô tả. M2, cùng lúc gắn route.
- **`oasdiff` chặn breaking change** — cần spec có `paths` mới có nghĩa; M2.
- **Bộ CI cross-tenant sinh từ OpenAPI (L3)** — nằm trong M2 (`M2-identity-authoring.md`).
- **Rule style/`recommended` của eslint** — M1 chỉ cưỡng chế luật kiến trúc; bật `recommended` bây giờ kéo theo một lượt sửa vô can làm loãng review.
- **Lint cấm query builder thô ngoài `modules/*/db/repo.ts` (cách ly L1)** — chưa có `db/repo.ts` nào tồn tại; đi cùng plan kernel Drizzle.
