# TestKite 🪁

> Nền tảng kiểm thử E2E no-code thay thế fork Testsigma — thiết kế đầy đủ tại
> [`../docs/SYSTEM_DESIGN.md`](../docs/SYSTEM_DESIGN.md) (blueprint) và
> [`../docs/ARCHITECTURE_AUDIT.md`](../docs/ARCHITECTURE_AUDIT.md) (audit nền).

**Vì sao "TestKite":** diều = *nhẹ* (sandbox runner nhẹ, sinh ra để chấm dứt lớp lỗi OOM);
sợi dây diều = *control plane* (PostgreSQL lease/dispatcher giữ mọi con diều — đứt dây là bump epoch,
không diều nào ghi verdict lậu); thả nhiều diều = *spawn nhiều sandbox*; và diều bay nhờ gió —
"làn gió mới" là lý do rewrite ngay từ đầu.

## Trạng thái

**Nguồn sự thật duy nhất về tiến độ: [`tasks/README.md`](tasks/README.md)** (bảng M1→M9 +
hash commit từng dòng). Cố ý KHÔNG nhắc lại ở đây — hai nơi ghi tiến độ thì nơi thứ hai
luôn là nơi lạc hậu.

## Cấu trúc

```
testkite/
├── apps/
│   ├── core/          # @testkite/core — Fastify modular monolith (12 module, DAG một chiều)
│   │   └── src/modules/{kernel,identity,governance,verbs,elements,testdata,
│   │                    authoring,planning,orchestration,results,integrations,ai,mcp-gateway}
│   ├── runner/        # @testkite/runner — worker claim job_runs (Postgres SKIP LOCKED)
│   │                  #   + Playwright chromium-headless-shell; zero-credential
│   └── ui/            # @testkite/ui — PLACEHOLDER (mới có src/main.tsx, chưa có test)
├── packages/
│   ├── contract/      # @testkite/contract — zod là NGUỒN hợp đồng; OpenAPI 3.1 sinh ra + commit
│   ├── run-compiler/  # @testkite/run-compiler — pure function, 7 phase (1→7), golden-tested
│   └── verb-kit/      # @testkite/verb-kit — op registry (2 verb đăng ký, thân còn TODO M4; 35 verb là M4)
├── docs/              # runbook vận hành + PROJECT_MAP.md (bản đồ cấu trúc)
├── tasks/             # BACKLOG theo milestone M1→M9 + open-questions (checklist làm việc)
├── ownership.json     # module → prefix bảng (cưỡng chế bằng lint, không phải văn hóa)
└── docker-compose.dev.yml  # PostgreSQL 17 + Valkey 8 + MinIO
```

**Bản đồ cấu trúc đầy đủ** — từng module một (trách nhiệm, bảng sở hữu, facade export, test nằm
đâu), DAG sinh từ `module-dag.json`, và bảng cổng CI: [`docs/PROJECT_MAP.md`](docs/PROJECT_MAP.md).

**Bắt đầu từ đâu:** mở [`tasks/README.md`](tasks/README.md) — bắt đầu thẳng M1 (clean break: không vá/bảo trì hệ cũ).
8 quyết định lớn đã chốt 27-08 (xem bảng đầu blueprint) — M1 hết bị chặn.

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
pnpm dev:infra     # PostgreSQL 17 + Valkey 8 + MinIO (docker-compose.dev.yml)
pnpm typecheck && pnpm test
```

### OIDC trong dev/test

- **Prod:** Keycloak self-host (quyết định 28-08-2026). Connector là **generic OIDC** —
  không có một dòng code nào riêng cho Keycloak; đổi IdP = đổi `issuer_url`.
- **Test + dev:** mini-IdP in-process (`apps/core/test/harness/mock-idp.ts`, ~200 dòng,
  dùng `jose`). Lý do: sandbox/CI runner không đảm bảo có docker daemon, và mini-IdP
  phát được **id_token độc hại theo yêu cầu** (hết hạn, sai `aud`/`iss`, ký bằng khoá
  ngoài JWKS) — thứ `oauth2-mock-server` không làm được, mà đó mới là phần đáng test.
  Chính ca `unknown_kid` là lý do connector BẮT BUỘC gọi
  `client.enableNonRepudiationChecks(config)`: mặc định `openid-client` KHÔNG kiểm chữ ký
  id_token (OIDC Core §3.1.3.7 mục 6), và TLS của ta có thể kết thúc ở reverse proxy nội bộ.
- **Keycloak service container trong CI — đã cân nhắc, CHƯA bật:** GitHub Actions chạy
  được `services: quay.io/keycloak/keycloak` (`start-dev`), nhưng nó tốn ~30–60s boot mỗi
  job và cần seed realm/client qua `kcadm`. Giá trị thêm so với mini-IdP chỉ là *tính
  tương thích cấu hình Keycloak thật* — thuộc smoke test M6, không thuộc định nghĩa "xanh"
  của M2. Khi bật: thêm job thứ ba `oidc-compat` chạy `test/identity/oidc-keycloak.test.ts`
  với `TESTKITE_TEST_OIDC_ISSUER`, và suite đó `skipIf` khi biến vắng mặt (đúng khuôn
  `describeRealPg` của M1).
