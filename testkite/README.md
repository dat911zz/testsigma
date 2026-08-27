# TestKite 🪁

> Nền tảng kiểm thử E2E no-code thay thế fork Testsigma — thiết kế đầy đủ tại
> [`../docs/SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md) (blueprint) và
> [`../docs/ARCHITECTURE_AUDIT.md`](../docs/ARCHITECTURE_AUDIT.md) (audit nền).

**Vì sao "TestKite":** diều = *nhẹ* (sandbox runner nhẹ, sinh ra để chấm dứt lớp lỗi OOM);
sợi dây diều = *control plane* (MySQL lease/dispatcher giữ mọi con diều — đứt dây là bump epoch,
không diều nào ghi verdict lậu); thả nhiều diều = *spawn nhiều sandbox*; và diều bay nhờ gió —
"làn gió mới" là lý do rewrite ngay từ đầu.

## Trạng thái

**Scaffold M1** — cấu trúc + hợp đồng + skeleton, chưa cài dependency. Xây theo thứ tự
blueprint: compiler core + golden test trước tiên (M1), rồi identity/tenancy (M2),
orchestration + fleet (M3)…

## Cấu trúc

```
testkite/
├── apps/
│   ├── core/          # @testkite/core — Fastify modular monolith (12 module, DAG một chiều)
│   │   └── src/modules/{kernel,identity,governance,verbs,elements,testdata,
│   │                    authoring,planning,orchestration,results,integrations,ai,mcp-gateway}
│   ├── runner/        # @testkite/runner — BullMQ worker + Playwright headless-shell
│   └── ui/            # @testkite/ui — React 19 + Vite, step-builder cho QA no-code
├── packages/
│   ├── contract/      # @testkite/contract — zod là NGUỒN hợp đồng; OpenAPI 3.1 sinh ra + commit
│   ├── run-compiler/  # @testkite/run-compiler — pure function, 9 phase, golden-tested
│   └── verb-kit/      # @testkite/verb-kit — op registry (35 verb active; Class.forName đã chết)
├── tasks/             # BACKLOG theo milestone M0→M9 + open-questions (checklist làm việc)
├── ownership.json     # module → prefix bảng (cưỡng chế bằng lint, không phải văn hóa)
└── docker-compose.dev.yml  # MySQL 8.4 + Valkey 8 + MinIO
```

**Bắt đầu từ đâu:** mở [`tasks/README.md`](tasks/README.md) — bắt đầu thẳng M1 (clean break:
không vá/bảo trì hệ cũ); 2 câu hỏi trong [`tasks/open-questions.md`](tasks/open-questions.md) đang chặn M1.

## Quy tắc bất di bất dịch (từ blueprint)

1. **Worker không có credential DB** — chỉ nói chuyện qua internal HTTP plane với token scope theo run.
2. **API image không chứa binary browser** — CI grep layer manifest, có chromium là fail build.
3. **AssertionFailure LÀ verdict (failed), không bao giờ retry** — chỉ `RetryableInfraError` được retry.
4. **Chỉ engine có layout thật được ghi verdict** (`results.engine` CHECK) — mọi thứ khác vào `advisory_signals`.
5. **AI chỉ ghi DRAFT** — con người promote; ngân sách + audit đầy đủ.
6. **Mọi container ship kèm memory limit tường minh** — CI từ chối manifest thiếu.

## Dev

```bash
nvm use && corepack enable
pnpm install
pnpm dev:infra     # MySQL 8.4 + Valkey + MinIO
pnpm typecheck && pnpm test
```
