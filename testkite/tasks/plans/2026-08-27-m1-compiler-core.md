# M1 — Compiler Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Compiler thuần (phase 1–7) biến snapshot authoring thành RunPlan bất biến content-hashed, với bộ golden test làm hợp đồng cho toàn hệ.

**Architecture:** Pure function trong `packages/run-compiler`, không I/O — orchestration nạp `CompileInput` (snapshot đã fetch), compiler trả `CompileOutput` (plan hoặc diagnostics). Verb bind qua registry `packages/verb-kit` (zod args). Hash = SHA-256 của payload canonical (sort key, không timestamp).

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`), pnpm workspaces, vitest, zod v3. CHƯA cần DB/Playwright ở plan này (kernel/Drizzle là plan M1 thứ hai).

**Spec:** `../../docs/SYSTEM_DESIGN.md` §4 (Run Compiler 9 phase) + §2 (ngữ nghĩa prereq/loop/group) + bảng quyết định đầu tài liệu.

## Global Constraints

- TypeScript strict, `exactOptionalPropertyTypes: true` — không dùng `any`, không `!` phi lý.
- Compiler là PURE: không import fs/net/db; không `Date.now()`/`Math.random()` trong đường sinh plan (hash phải ổn định).
- Mọi lỗi GOM hết (không first-fail); mỗi `CompileErrorCode` có ≥1 fixture âm.
- Prereq: cycle-free, depth ≤ 5 (luật kế thừa hệ cũ, đã xác minh). Step-group inline depth ≤ 5.
- `AssertionFailure` semantics không thuộc compiler — compiler chỉ sinh plan.
- Commit nhỏ sau mỗi task; TDD đúng nghi thức (test fail trước, code sau).

---

## Task 1 — Toolchain: deps + vitest chạy được

- [x] Thêm dep root: `typescript@~5.7`, `vitest@^3`, `@types/node@^22`; per-package: `zod@^3.24` cho contract/verb-kit/run-compiler; workspace refs `@testkite/contract`, `@testkite/verb-kit` vào run-compiler
- [x] `vitest.config.ts` root (projects = packages/*)
- [x] Viết test trivial `packages/contract/src/index.test.ts` (RUN_VERDICTS chứa "compile_error")
- [x] `pnpm install` → `pnpm typecheck` xanh → `pnpm test` xanh
- [x] Commit: "M1 T1: toolchain + first test"

## Task 2 — Contract: zod hoá các union + AuthoredSnapshot types

- [x] Test: parse hợp lệ/không hợp lệ cho `runVerdictSchema`, `jobStatusSchema`
- [x] Implement zod schemas song song các union hiện có (không phá type cũ)
- [x] Định nghĩa types input compiler trong `run-compiler/src/snapshot.ts`: `AuthoredCase` (id, revisionId, name, isStepGroup, prereqCaseId?, dataProfileId?, expectedRows?), `AuthoredStep` (ordinal, kind: action|step_group|if|for|while|rest, verbOpKey?, args, elementRef?, stepGroupCaseId?, conditionExpected?, loop config, children?), `ElementSnapshot` (id, name, status, locators[]), `DataProfileSnapshot`, `EnvSnapshot` (baseUrl, vars, secretNames)
- [x] Commit: "M1 T2: contract zod + compiler snapshot types"

## Task 3 — Phase 1: resolve chuỗi prereq (TDD)

- [x] Test đỏ: chain đơn (login→case) ra thứ tự [login, case]; case không prereq ra [case]
- [x] Test đỏ: cycle A→B→A ⇒ diagnostic `prereq_cycle` (kèm caseId), không plan
- [x] Test đỏ: depth 6 ⇒ `prereq_depth_exceeded`; depth 5 OK
- [x] Test đỏ: prereq trỏ case không tồn tại ⇒ `prereq_missing` (thêm code mới vào union)
- [x] Test đỏ: 2 case cùng prereq login ⇒ 2 chain riêng, login KHÔNG chạy chung (chain = đơn vị cô lập)
- [x] Implement `resolveChains(snapshot, scope)` tối thiểu cho pass; chạy verify
- [x] Commit: "M1 T3: phase1 chain resolution"

## Task 4 — Phase 2: nở cấu trúc (TDD)

- [x] Test đỏ: step_group inline (group 3 step → case thấy 3 step phẳng, giữ renderedSentence gốc + provenance groupId)
- [x] Test đỏ: group lồng depth 6 ⇒ `step_group_depth_exceeded`; group tự gọi mình ⇒ cùng code (cycle qua depth)
- [x] Test đỏ: `if` block → node điều kiện với children; `for` với dataProfile rỗng ⇒ `data_profile_empty`
- [x] Test đỏ: `while` thiếu maxIterations ⇒ `while_without_max_iterations`
- [x] Test đỏ: case data-driven 3 hàng ⇒ 3 CasePlan iteration (label từ row), hàng `expected_to_fail` giữ cờ
- [x] Implement expansion; commit "M1 T4: phase2 structural expansion"

## Task 5 — Phase 3: bind verb (TDD)

- [x] Test đỏ: opKey lạ ⇒ `unknown_verb` (GOM: 2 verb lạ ⇒ 2 diagnostics)
- [x] Test đỏ: args thiếu param required (zod của verb-kit) ⇒ `verb_args_invalid` kèm ordinal
- [x] verb-kit: thêm zod schema args cho web.click/web.enter; helper `validateArgs(opKey, args)`
- [x] Implement bind; commit "M1 T5: phase3 verb binding"

## Task 6 — Phase 4+5: element + data/env merge (TDD)

- [x] Test đỏ: elementRef → LocatorSet trong StepPlan; element `pending_locator` ⇒ `element_pending_locator`; ref lạ ⇒ `element_not_found`
- [x] Test đỏ: arg `$secret:NAME` giữ nguyên dạng ref, NAME không có trong env.secretNames ⇒ `secret_ref_unknown`; KHÔNG bao giờ inline giá trị
- [x] Implement; commit "M1 T6: phase4-5 element + data merge"

## Task 7 — Phase 6+7: stamp + freeze + hash (TDD)

- [ ] Test đỏ: cùng input ⇒ cùng `contentHash` qua 2 lần gọi; đổi 1 arg ⇒ hash đổi; thứ tự key trong object args không ảnh hưởng hash (canonical sort)
- [ ] Test đỏ: có ≥1 error ⇒ `plan === undefined` + đủ diagnostics
- [ ] Implement canonicalize (sort keys đệ quy) + SHA-256 (node:crypto) + timeout formula `clamp(90+12×steps,180..900)`; zstd ĐỂ SAU (payload thô — ghi chú planFormatVersion=1 chưa nén)
- [ ] Commit "M1 T7: freeze + content hash"

## Task 8 — Bộ golden fixtures (hợp đồng T1 của hệ)

- [ ] `fixtures/` ≥ 20 case: mỗi construct 1 dương; mỗi `CompileErrorCode` ≥ 1 âm; 1 fixture "kitchen-sink" (prereq chain + group + if + for + data-driven)
- [ ] Golden runner: snapshot JSON plan (đã canonical) so khớp file `.golden.json`; script `pnpm -F @testkite/run-compiler test:golden -u` để update có chủ đích
- [ ] Commit "M1 T8: golden suite"

## Task 9 — CI

- [ ] `.github/workflows/testkite-ci.yml`: pnpm install + typecheck + test trên push/PR paths `testkite/**`
- [ ] Commit "M1 T9: CI"

## Task 10 — (Plan riêng kế tiếp) kernel Drizzle pg + tenancy + outbox

- [ ] Viết plan `2026-XX-XX-m1-kernel-db.md` (cần Testcontainers PG) — KHÔNG gộp vào plan này (ranh giới reviewer rõ)
