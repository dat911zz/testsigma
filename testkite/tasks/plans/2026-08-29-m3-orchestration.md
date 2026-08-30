# M3 — Orchestration control plane (queue `job_runs`, dispatcher, lease/epoch, results + SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng **nửa control-plane** của M3 — `job_runs` làm queue-of-record trên Postgres, phase 0 + 8–9 của compiler pipeline, dispatcher FIFO có leader-elect, lease/epoch fencing, internal HTTP plane `/internal` cho worker zero-credential, results 3 tầng partition tháng và SSE trạng thái run — sao cho giết `-9` một worker giữa chừng thì chain được requeue đúng một lần, zombie bị 409 `STALE_EPOCH`, và kết quả đọc theo `MAX(attempt)`.

**Architecture:** Postgres là **queue + lease authority duy nhất** (không Redis, không BullMQ cho job chạy test — BullMQ chỉ dùng cho domain event của relay M1). Vòng đời một job: `pending` → dispatcher (leader) đẩy sang `dispatched` → worker claim bằng conditional UPDATE bump `lease_epoch` → `running` → complete/reap. Mọi mutation từ worker mang `leaseEpoch`; server luôn ghi bằng `UPDATE ... WHERE lease_epoch = $leaseEpoch` nên zombie ghi 0 row ⇒ 409. Worker **không có credential DB**: nó chỉ nói chuyện với `/internal/fleet` bằng *run token* phát tại thời điểm claim, scope đúng một `(job_run_id, attempt, lease_epoch)`. Results tách sang module `results` (`res_*`), partition theo tháng, ghi append theo `attempt`, đọc theo `MAX(attempt)`.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), pnpm workspace, vitest 3, zod 3, `drizzle-orm@^0.45.2`, `drizzle-kit@^0.31.10`, `pg@^8.23.0`, `fastify@^5.12.1`, `fastify-type-provider-zod@4.0.2`, `@electric-sql/pglite@^0.5.8` (unit), PostgreSQL 17 (CI/prod — engine có thẩm quyền), `node:crypto` (SigV4 presign, không SDK).

**Spec:** `../../../docs/SYSTEM_DESIGN.md` §5 (fleet 2 mặt phẳng, lease, epoch, dispatcher, observability) + §4 (Run Compiler 9 phase, queue-of-record, taxonomy lỗi, testing 8 tầng). Backlog: `../M3-orchestration-fleet.md`. Nền tảng đã có: `../plans/2026-08-27-m1-kernel-db.md` (withTenant, RLS, SKIP LOCKED), `../plans/2026-08-28-m2-authoring.md` (`buildCompileSnapshot`), `../plans/2026-08-28-m2-identity.md` (ROUTES descriptor, hook auth, bộ L3).

## Global Constraints

- **NGÔN NGỮ:** mọi CODE và TEST viết **tiếng Anh** (comment, docstring, tên `describe`/`it`, message lỗi, log). Văn xuôi plan tiếng Việt. Gate: grep ký tự có dấu tiếng Việt trong `src/**`, `test/**`, `tools/**` phải = 0.
- TypeScript strict, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true` — không `any`, không `!` phi lý.
- **Database = PostgreSQL 17.** Queue-of-record = `job_runs` trên Postgres, claim bằng `FOR UPDATE SKIP LOCKED`.
- Mọi bảng tenant-scoped mới: `team_id` **dẫn đầu index** + `UNIQUE(team_id, id)` (bảng partition: thêm partition key vào key) + **composite FK** `(team_id, parent_id)` + **RLS** policy `tenant_isolation` với vị từ `team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`.
- **Cross-tenant ⇒ 404, không bao giờ 403.**
- Bảng thuộc **đúng 1 module** theo `testkite/ownership.json`: orchestration sở hữu `orc_`, `job_runs`, `egress_policies`; results sở hữu `res_`; governance sở hữu `usage_counters`. Import chéo module **chỉ qua facade**, xuôi theo `module-dag.json`.
- **AssertionFailure là VERDICT, không bao giờ retry.** Chỉ `RetryableInfraError` mới requeue. App treo = `failed(timeout)`.
- **Worker zero-credential:** không credential DB, không credential team. Token của worker scope theo đúng run đang chạy.
- `apps/core` KHÔNG BAO GIỜ chứa binary browser (CI grep gate đã có).
- Compiler (`packages/run-compiler`) là **PURE** — plan này không được thêm fs/net/db/`Date.now()` vào đó. Mọi I/O của phase 0 và 8–9 nằm ở `apps/core/src/modules/orchestration`.
- Commit nhỏ sau mỗi task; TDD đúng nghi thức (test ĐỎ trước, code sau).

---

## Hợp đồng cho plan fleet (`2026-08-29-m3-fleet.md`)

Plan này **SỞ HỮU** control plane: DB (`job_runs`, `orc_*`, `res_*`), dispatcher, internal API, results. Plan fleet là **CLIENT**. Hai bên chỉ gặp nhau qua hợp đồng dưới đây — không bên nào sửa file của bên kia.

Plan fleet đã nộp trước (commit `23bd09f`) với một **hợp đồng giả định** ở mục "Endpoint giả định", và tự nhận: "khi plan orchestration chốt, sửa **một** file `control-plane-client.ts` + harness của nó". Hợp đồng chốt dưới đây **cố ý bám sát giả định đó** — mọi chỗ hai bên tương đương về kỹ thuật thì lấy đúng tên/hình dạng bên kia đã viết, để số dòng phải sửa gần bằng 0. Danh sách chênh lệch còn lại nằm ở cuối mục.

### Bề mặt `/internal/fleet` (Fastify RIÊNG, cổng riêng `INTERNAL_PORT`, host mặc định `127.0.0.1`)

Ba loại credential, không loại nào thay được loại nào:

| Loại | Ai giữ | Nguồn | Endpoint được phép |
|---|---|---|---|
| **bootstrap token** (`tkb_…`) | `runnerd` trên host, đặt trong systemd credential | cấu hình (`FLEET_BOOTSTRAP_TOKEN`), xoay tay | `POST /internal/fleet/workers/register` |
| **worker token** (`tkw_…`) | tiến trình worker sau khi register | trả về từ `register`, TTL 24h, gia hạn ở mỗi worker-heartbeat | worker-heartbeat, `claim` |
| **run token** (`tkr_…`) | worker đang chạy đúng job đó | trả về **cùng response của claim**, TTL = `leaseDeadlineAt + 60s` | 4 endpoint của job, **chỉ đúng `jobRunId` trong token** |

Run token **không phải credential team**: không mang `scopes`, không đọc được bảng nghiệp vụ nào, chết cùng lease.

| Method + path | Dùng để | Auth |
|---|---|---|
| `POST /internal/fleet/workers/register` | worker đăng ký, nhận `workerId` + `workerToken` | bootstrap token |
| `POST /internal/fleet/workers/{workerId}/heartbeat` | heartbeat 5s của worker + PSI, nhận lệnh `continue`/`drain` | worker token |
| `POST /internal/fleet/claim` | claim **1** job (conditional UPDATE bump `lease_epoch`) | worker token |
| `POST /internal/fleet/jobs/{jobRunId}/heartbeat` | giữ lease của job đang chạy | run token |
| `POST /internal/fleet/jobs/{jobRunId}/events` | báo tiến độ, idempotent theo `seq` | run token |
| `POST /internal/fleet/jobs/{jobRunId}/artifacts` | xin presigned PUT | run token |
| `POST /internal/fleet/jobs/{jobRunId}/complete` | báo verdict cuối | run token |

```jsonc
// POST /internal/fleet/workers/register        auth: bootstrap token
{ "workerId": "w-1", "hostname": "runner-a", "lane": "batch", "capacity": 4 }
// 200:
{ "workerId": "w-1", "lane": "batch", "workerToken": "tkw_…",
  "heartbeatIntervalMs": 5000, "drain": false }

// POST /internal/fleet/workers/{workerId}/heartbeat   auth: worker token
{ "freeSlots": 2, "psi": { "some10": 0.03, "full10": 0.0 }, "rssBytes": 1288490188 }
// 200:
{ "command": "continue" | "drain", "workerTokenRenewedAt": "2026-08-29T10:00:00.000Z" }

// POST /internal/fleet/claim                   auth: worker token
{ "workerId": "w-1", "lane": "batch", "freeSlots": 3 }
// 204 (no body) when the queue has nothing for this lane — NOT an error
// 200:
{ "jobRunId": "…", "runId": "…", "teamId": "…", "projectId": "…",
  "chainKey": "login>checkout", "attempt": 1, "leaseEpoch": 7,
  "leaseDeadlineAt": "2026-08-29T10:00:30.000Z", "runToken": "tkr_…",
  "plan": { /* the frozen RunPlan, verbatim from @testkite/run-compiler */ } }

// POST …/jobs/{jobRunId}/heartbeat             auth: run token
{ "leaseEpoch": 7 }
// 200: { "leaseDeadlineAt": "…", "command": "continue" | "drain" | "cancel" }

// POST …/jobs/{jobRunId}/events                auth: run token
{ "leaseEpoch": 7, "seq": 12, "kind": "step_finished",
  "payload": { "caseId": "c1", "ordinal": 3, "status": "passed", "durationMs": 812 } }
// 202: { "accepted": true, "duplicate": false }
// kind ∈ chain_started | case_started | case_finished | step_started | step_finished
//        | screenshot | infra_error

// POST …/jobs/{jobRunId}/artifacts             auth: run token
{ "leaseEpoch": 7, "kind": "trace" | "screenshot" | "screenshot_bundle" | "video" | "log",
  "contentType": "application/zip", "sha256": "<64 hex>", "sizeBytes": 3304 }
// 200: { "artifactId": "…", "method": "PUT", "url": "https://minio…?X-Amz-Signature=…",
//        "headers": { "Content-Type": "application/zip" }, "expiresAt": "…" }

// POST …/jobs/{jobRunId}/complete              auth: run token
// (a) a verdict — never retried:
{ "leaseEpoch": 7, "verdict": "passed" | "failed" | "aborted_early" | "cancelled",
  "steps": [ { "caseId": "c1", "ordinal": 1, "status": "passed", "durationMs": 91,
               "renderedSentence": "Click Login", "failureContext": null,
               "screenshotArtifactId": null, "thumbhash": null } ],
  "artifacts": [ { "kind": "trace", "sha256": "…", "sizeBytes": 3304 } ] }
// (b) an infrastructure error — the control plane decides whether to requeue:
{ "leaseEpoch": 7, "infraError": { "code": "browser_oom", "retryable": true,
  "message": "chromium killed by cgroup", "peakRssBytes": 1728053248 } }
// 200: { "ok": true, "requeued": false, "attempt": 1 }
```

### Luật epoch (bất di bất dịch — plan fleet code theo đúng đây)

1. Worker **phải** gửi `leaseEpoch` trong body của **mọi** mutation (`heartbeat`, `events`, `artifacts`, `complete`). Thiếu field ⇒ **400 `VALIDATION_FAILED`**.
2. Server ghi bằng `UPDATE … WHERE team_id=$t AND id=$j AND lease_epoch=$leaseEpoch`. 0 row ⇒ **409 `STALE_EPOCH`** kèm `{ "code": "STALE_EPOCH", "currentEpoch": <n> }`. Worker phải bỏ job, đóng context trong `finally`, **không gọi thêm endpoint nào cho job đó**, không upload artifact.
3. `leaseEpoch` trong body phải khớp epoch nhúng trong run token; lệch ⇒ 409 `STALE_EPOCH` (không phải 401 — để worker phân biệt "token hỏng" với "mình bị thu hồi lease").
4. Job của team khác / id không tồn tại ⇒ **404 `NOT_FOUND`**, không bao giờ 403.
5. `complete` mang `infraError` **và** còn lượt retry ⇒ server requeue (`"requeued": true`), attempt+1, epoch+1, run token bị revoke ngay. `verdict: "failed"` do assertion ⇒ **không bao giờ** requeue.
6. Worker **không tự quyết retry**: nó chỉ khai `retryable` theo taxonomy; control plane là nơi quyết.

### Mã lỗi trả về từ `/internal/fleet`

| HTTP | `code` | Khi nào | Worker phải làm gì |
|---|---|---|---|
| 204 | — | không có job cho lane này | ngủ `claimIdleMs` rồi claim lại |
| 400 | `VALIDATION_FAILED` | thiếu `leaseEpoch`/`seq`, body sai schema | bug của worker — log, bỏ job |
| 401 | `UNAUTHORIZED` | token sai/hết hạn/sai loại | thoát 1, systemd dựng lại + register lại |
| 404 | `NOT_FOUND` | jobRunId lạ hoặc khác team | bỏ job, tiếp tục vòng lặp |
| 409 | `STALE_EPOCH` | epoch cũ (đã bị reap/cancel) | **tự tử**: bỏ job, đóng context, không ghi gì thêm |
| 410 | `JOB_CANCELLED` | run bị huỷ | huỷ chain, đóng context, KHÔNG complete |
| 410 | `JOB_TERMINAL` | job đã kết thúc (succeeded/failed) | bỏ job |
| 429 | `RATE_LIMITED` | quá số claim/giây của một worker | backoff mũ có jitter theo `Retry-After` |

### Chênh lệch so với "hợp đồng giả định" trong plan fleet — đúng 5 chỗ

Người thực thi plan fleet chỉ cần sửa `apps/runner/src/control-plane-client.ts` + harness của nó:

1. **Register cần bootstrap token, và trả về `workerToken`** — plan fleet đã viết đúng như vậy. **Không đổi gì.** (Ghi ở đây để khẳng định, vì plan orchestration bản nháp trước dùng một "fleet token" duy nhất.)
2. **`leaseDeadlineAt`** là tên trường thời hạn lease trong response claim/heartbeat (giữ nguyên tên plan fleet đã dùng). **Không đổi gì.**
3. **`complete` có thêm trường tuỳ chọn `renderedSentence` / `failureContext` / `screenshotArtifactId` / `thumbhash` cho mỗi step.** Plan fleet gửi thiếu ⇒ server nhận giá trị mặc định (`""`/`null`), không lỗi. Muốn gallery ảnh từng step + ThumbHash (blueprint §5.2) hoạt động thì phải gửi.
4. **`events.kind` là enum đóng 7 giá trị.** Plan fleet mới liệt kê `step_finished`; gửi `kind` ngoài danh sách ⇒ 400.
5. **`artifacts.kind` là enum đóng 5 giá trị** (`trace`/`screenshot`/`screenshot_bundle`/`video`/`log`) và **`sizeBytes` ≤ 2 147 483 647**; vượt ⇒ 400, server không ký URL.

Ngoài 5 điểm trên: **đường dẫn, tên trường, mã lỗi, 204-khi-rỗng, `infraError` giữ y nguyên** như plan fleet đã giả định.

### Điều plan fleet PHẢI tự lo (ngoài phạm vi plan này)

Vòng lặp worker, executor Playwright, cgroup lồng + memory governance L1–L3, quarantine tại chỗ trên host, recycle browser/context, `runnerd`, unit systemd, upload thực sự lên presigned URL, trace/screenshot ring-buffer trên NVMe.

### Tranh chấp file giữa hai plan (hai agent, một nhánh)

| Tài nguyên | Rủi ro | Quy trình |
|---|---|---|
| `apps/core/drizzle/NNNN_*.sql` | số thứ tự migration là **tài nguyên tranh chấp** | Plan này tạo migration; plan fleet **không tạo migration nào** (worker zero-credential). Luôn tham chiếu bằng **TAG** (`m3_job_runs`, …), không bằng số. Sau `git pull --rebase` mà số bị chiếm: **xoá file sinh máy, chạy lại `pnpm db:generate --name=<tag>`** (drizzle-kit tự lấy số trống + tự vá `_journal.json`), rồi đổi tên file grants viết tay + sửa entry journal tương ứng. |
| `packages/contract/src/routes/index.ts` (`ROUTES`) | cả hai cùng append | Chỉ plan này chạm `ROUTES`, và chỉ append `...orchestrationRoutes` vào CUỐI mảng. `/internal/fleet` **KHÔNG** vào `ROUTES` (Task 13) — `ROUTES` chỉ chứa route `/v1` của tenant. |
| `packages/contract/src/routes/internal.ts` | plan fleet cần kiểu `ClaimedJob` để không copy-paste | File do **plan này** sở hữu và tạo (Task 13); plan fleet **import** `INTERNAL_ROUTES` + các zod schema từ `@testkite/contract`, không tự khai lại kiểu. |
| `apps/core/src/composition-root.ts` | cả hai cùng thêm dòng wiring | Plan này thêm **đúng một khối** `buildInternalApp(...)` + `startDispatcher(...)` ở cuối `buildApp`. Plan fleet không sửa file này (worker là tiến trình riêng `apps/runner`). Sau rebase: giữ cả hai khối, không xoá của nhau. |
| `packages/contract/openapi.json` | gate drift so byte | Chạy lại `pnpm openapi:gen` sau mỗi rebase. `/internal/fleet` không xuất hiện trong openapi.json (có chủ đích) — có gate CI grep (Task 15). |
| `apps/runner/**` | plan fleet sở hữu toàn bộ | Plan này **không** đụng `apps/runner`. |

---

## Kết quả spike (ĐÃ CHẠY THẬT — 2026-08-29, sandbox này, PostgreSQL 16.13 qua `scripts/test-pg.sh`)

`eval "$(scripts/test-pg.sh start)"` → `postgres://postgres@127.0.0.1:55432/postgres`, `PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)`. **CI dùng `postgres:17` và là engine có thẩm quyền** — mọi kết luận dưới đây phải được test lại ở tầng `test/concurrency/` khi CI chạy.

### 1. Claim `FOR UPDATE SKIP LOCKED` — hai connection ra tập DISJOINT

8 job `dispatched`, hai connection cùng claim `LIMIT 3`, connection A giữ transaction MỞ:

```
A claimed seq = [1,2,3] epochs = [1,1,1]
B claimed seq = [4,5,6] epochs = [1,1,1]
intersection = []  (must be []) both claims took 8 ms while A tx OPEN
C claimed remaining seq = [7,8]
```

Không giao nhau, không chờ nhau (8ms cho cả hai lượt trong khi A chưa commit). Đây là bằng chứng SKIP LOCKED làm đúng việc; **PGlite không tái hiện được** (một connection wasm), nên test này bắt buộc nằm ở `test/concurrency/`.

### 2. Conditional UPDATE bump epoch — zombie bị chặn, cross-tenant = 0 row

```
reaper bump: rows = 1 new epoch = 2 attempt = 2
zombie writes verdict with STALE epoch 1 -> rows = 0 (must be 0 => 409 STALE_EPOCH)
current owner writes with FRESH epoch 2 -> rows = 1 (must be 1)
cross-tenant update (team B + id A) -> rows = 0 (must be 0 => 404)
```

`rowCount === 0` là **toàn bộ** cơ chế fencing — không cần lock phân tán, không cần Redis.

### 3. Leader-elect: `pg_advisory_lock` vs row-lock có TTL

```
[adv] leader acquires        : true
[adv] follower try while held: false
[adv] SAME session 2nd try   : true (reentrant, refcount = 2)
[adv] follower after 1 unlock: false (refcount vẫn 1)
[adv] failover after backend kill: 2 ms, ticks = 1 (poll 250ms)
[adv] after client socket destroy, follower try: true (server thấy FIN ⇒ nhả khoá)

[row] dispatcher-1 acquires  : rows = 1 epoch = 1
[row] dispatcher-2 while held: rows = 0
[row] dispatcher-1 renews    : rows = 1 epoch = 1 (cùng epoch = không đổi chủ)
[row] failover after silent death: 5032 ms (TTL=5s), ticks=21, new epoch = 2
[row] old leader renew with stale (holder,epoch): rows = 0
```

Bẫy đã đo được của advisory lock (quyết định sinh ra từ đây):

```
acquire on pooled client: true
c1.release()                       // trả về pool, session KHÔNG reset
another pooled client tries: true  // ⇐ pool trả lại ĐÚNG session đó ⇒ "leader thứ hai"
advisory locks still held after release(): 1
```

và cấu hình keepalive mặc định của server:

```
tcp_keepalives_idle = 7200   tcp_keepalives_interval = 75   tcp_keepalives_count = 9
idle_session_timeout = 0     idle_in_transaction_session_timeout = 0
```

**QUYẾT ĐỊNH: chọn row-lock có TTL (`orc_dispatcher_lease`), KHÔNG dùng `pg_advisory_lock` cho leader-elect.** Lý do, theo thứ tự sức nặng:

1. **Dead-man alert cần một hàng nhìn thấy được.** Blueprint §5 (observability tuần 1) yêu cầu metric "dispatcher dead-man". Advisory lock vô hình: `pg_locks` chỉ cho biết *có ai đó* đang giữ, không cho biết ai, từ bao giờ, tick cuối lúc nào. Row lease mang sẵn `holder`, `epoch`, `acquired_at`, `last_tick_at`, `expires_at` — alert là một câu `SELECT`.
2. **Advisory lock có worst case 2 tiếng.** Đo được: khi client gửi FIN thì khoá nhả ngay (2ms), nhưng **phân vùng mạng thật thì server không thấy FIN**; khoá sống tới khi TCP keepalive giết session — mặc định `7200 + 9×75` ≈ **2h07** không có dispatcher. Đó là setting phía server, trên managed Postgres ta không luôn sửa được. TTL 5s thì worst case là 5s bất kể kiểu chết nào (đo: 5032ms).
3. **Bẫy pool tái sử dụng session là lỗi im lặng.** Đo được ở trên: `pg.Pool` trả lại đúng session cũ ⇒ `pg_try_advisory_lock` **thành công lần hai** ⇒ hai tiến trình cùng tin mình là leader, không có tín hiệu nào báo. Row lease không có hạng mục "session" nào để mà rò.
4. **Đúng tính chất của bài toán: leader chỉ là tối ưu hoá, không phải điều kiện đúng đắn.** Dispatch chính nó đã an toàn nhờ SKIP LOCKED + conditional UPDATE (mục 1, 2), nên split-brain trong cửa sổ TTL chỉ làm phí một tick, không làm một job chạy hai lần. Đổi 5s failover lấy khả năng quan sát + trần thời gian ổn định là món hời.

Tham số chốt: **TTL 10s, renew mỗi 2.5s (mỗi tick thứ 10), ứng viên thăm dò 250ms.** Đo với TTL 5s ra 5032ms; TTL 10s ⇒ failover ≈ 10s, vẫn thấp hơn nhiều so với ngưỡng "fallback FIFO 120s" của blueprint. `epoch` của lease chỉ để fence leader cũ (đo: renew bằng `(holder, epoch)` cũ ⇒ 0 row).

`pg_advisory_lock` **vẫn được dùng** ở chỗ nó hợp: khoá promote `(team, case)` của M2 — nơi vòng đời khoá gói gọn trong một request.

### 4. Requeue vào ĐẦU hàng đợi của đúng team đó

`queue_seq bigint` (từ sequence), thứ tự đọc `(priority DESC, queue_seq ASC)`; requeue lấy `MIN(queue_seq) - 1` **trong phạm vi team**:

```
initial pending order        : A1#1 B1#2 A2#3 A3#4 B2#5 A4#6
after A2 claimed             : A1#1 B1#2 A3#4 B2#5 A4#6
requeue rows = 1 new queue_seq = 0 attempt = 2 epoch = 2
after requeue-at-team-head   : A2#0 A1#1 B1#2 A3#4 B2#5 A4#6
head per team                : A2 B1
```

Requeue lần hai không trôi đi đâu (`queue_seq` vẫn 0, `attempt=3`). Bẫy đã đo:

```
concurrent requeue: A2 -> 0  A3 -> 0   COLLISION (tie => nondeterministic order)
serialized requeue: A2 -> 0  A3 -> -1
```

Hai reaper chạy song song trên cùng team sinh **hoà giá trị** ⇒ thứ tự lấy job không xác định. Hai lớp chống: (a) reaper **chỉ chạy trong tick của leader** nên các requeue nối tiếp nhau; (b) khoá thứ tự đầy đủ là `(priority DESC, queue_seq ASC, id ASC)` ⇒ dù có hoà thì thứ tự vẫn *tất định*, không bao giờ là "lúc thế này lúc thế kia".

### 5. Chỉ số cho dispatcher — partial index phải khớp ĐÚNG mệnh đề ORDER BY

20.000 row pending, 20 team, fan-out 200/tick:

```
seeded 20000 pending rows in 266 ms
dispatch fan-out 200: 200 rows in 19 ms / 16 ms / 17 ms
worker claim 4: 4 rows in 1 ms

BEFORE (index (lane, priority DESC, queue_seq) WHERE status='pending', query không lọc lane):
    ->  Seq Scan on job_runs2 (rows=19400)      Execution Time: 10.007 ms
AFTER  (index (priority DESC, queue_seq) WHERE status='pending'):
    ->  Index Scan using jr2_pending2 (rows=200) Execution Time: 0.205 ms
lane-scoped worker claim (dispatched, batch):
    ->  Index Scan using jr2_ready (rows=4)      Execution Time: 0.038 ms
reaper scan (index on lease_expires_at WHERE status='running'): Execution Time: 0.010 ms
```

**49× chênh lệch** chỉ vì cột dẫn đầu của partial index không khớp `ORDER BY`. Dispatcher không lọc `lane` (nó xét mọi lane) nên index của nó **không được** có `lane` dẫn đầu; ngược lại claim của worker luôn có `lane` nên index của claim thì phải có. Hai partial index riêng, không gộp.

### 6. `job_runs` phải đọc được XUYÊN team ở đường claim, nhưng lọc theo team ở đường request

Hai policy trên cùng một bảng, hai role:

```
app role, team A        : 3   (expect 3)
app role, NO app.team_id: 0   (fail-closed)
dispatch role, no team  : 5   (đọc xuyên team = đường claim)
dispatch INSERT blocked : 42501 permission denied for table jrx
app role (team A) updating a team-B row: 0 rows (=> 404)
app role AFTER being granted dispatch role, team A: 5  ⇐ policy PERMISSIVE bị OR qua role KẾ THỪA
```

Dòng cuối là một lỗ hổng thật: **tuyệt đối không `GRANT testkite_dispatch TO testkite_app`** — policy permissive cộng dồn qua role kế thừa, `testkite_app` sẽ đọc được mọi team. Task 1 có test khẳng định điều này.

### 7. Partition tháng cho `res_*` — kiểm chứng lại bằng lệnh thật, không chép niềm tin M2

```
FAIL  PK (team_id,id) trên bảng PARTITION BY RANGE(started_at)
      -> 0A000 unique constraint on partitioned table must include all partitioning columns
OK    PK (team_id,id,started_at)
FAIL  UNIQUE (team_id,id) trên parent  -> 0A000 (cùng lý do)
OK    UNIQUE (team_id,id,started_at)
OK    res_step_results partition + composite FK (team_id, case_result_id, case_result_started_at)
        -> res_case_results (team_id, id, started_at)          ⇐ FK trỏ vào bảng partition CHẠY ĐƯỢC (PG≥12)
rows visible to team A via PARENT : 2   (đúng)
rows visible to team A via CHILD after GRANT on child: 3   ⇐ RÒ CHÉO TENANT
relrowsecurity: res_case_results=true  res_case_results_2026_08=false
insert vào partition tạo SAU khi GRANT parent: OK (grant của parent kế thừa xuống)
cross-tenant INSERT blocked: 42501 new row violates row-level security policy
MAX(attempt) read (DISTINCT ON): attempt=2/passed attempt=2/failed attempt=1/passed
FAIL  DETACH ... CONCURRENTLY khi có DEFAULT partition
      -> 55000 cannot detach partitions concurrently when a default partition exists
```

Ba luật rút ra, giống hệt `audit_events` của M2 nhưng lần này đo lại trên chính schema `res_*`: **(1)** key duy nhất phải chứa partition key; **(2)** `GRANT` **chỉ trên bảng cha** — partition con có `relrowsecurity=false`, một `GRANT SELECT` trên con là đọc vượt tenant; **(3)** có default partition ⇒ retention dùng `DETACH` thường trong cửa sổ bảo trì, không `CONCURRENTLY`.

### 8. SSE trên Fastify 5 — không cần plugin

```
/sse-raw status 200 content-type: text/event-stream
  body: "id: 1\nevent: tick\ndata: {\"n\":1}\n\n…event: done\ndata: {}\n\n"
/sse-gen (Readable.from(async generator)) status 200 — cũng chạy
after client abort: timer cleared = true | events = ["raw:close n=3","gen:close","long:close"]
active timers still holding the loop: 0
fastify version: 5.12.1
onRequest hook ran for /resume                       ⇐ hook auth vẫn chạy TRƯỚC hijack
/resume 200 text/event-stream ": heartbeat\n\ndata: {\"lastEventId\":\"42\",\"team\":\"team-A\"}\n\n"
```

Kết luận: **không cài plugin SSE nào.** Dùng `reply.hijack()` + `reply.raw.writeHead(...)` + `reply.raw.write(...)`; dọn dẹp bằng `req.raw.on("close", …)` (đo: `clearInterval` chạy, không còn timer treo event loop). `Last-Event-ID` đi qua header bình thường ⇒ resume được. `reply.hijack()` cũng **bỏ qua serializer của response schema** — nghĩa là route SSE **không** đăng ký được qua đường `registrations` của `buildHttpApp` (đường đó luôn `reply.code(status).send(result)`), phải đăng ký kiểu plugin như authoring.

### 9. Presigned PUT bằng `node:crypto`, không SDK

Cài đặt SigV4 ~40 dòng, đối chiếu với **test vector chính thức của AWS** (GET presigned, `examplebucket/test.txt`, 20130524T000000Z):

```
AWS doc vector signature: aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
expected                : aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
MATCH = true
10k PUT presigns in 311.7 ms      (~31 µs/URL)     url length: 317
```

Không thêm dependency nào (`@aws-sdk/*` hay `minio` đều thừa cho đúng một thao tác ký).

### 10. Event idempotent theo seq + reaper + NOTIFY

```
seq 2 REPLAY  rows = 0 (idempotent)
seq 2 với kind KHÁC rows = 0 (ghi đầu tiên thắng — không cho sửa lịch sử)
seq 4 out of order rows = 1        stored: 1:step_started 2:step_finished 4:chain_finished
gap check: max(seq)=4 count=3 => gap present = true
suspect (>15s): A2@31s A3@17s
reaped dead (>30s) in 1 ms: A2 attempt=2 epoch=2 seq=0
NOTIFY→LISTEN latency ms: 0.94 0.40 0.36 0.29 0.34
```

`UNIQUE (team_id, job_run_id, attempt, seq)` + `ON CONFLICT DO NOTHING` là toàn bộ cơ chế idempotent. NOTIFY nhanh (~0.3ms) nhưng cần một connection LISTEN riêng cho mỗi instance API — v1 SSE dùng poll 1s (xem Task 14), NOTIFY ghi vào mục "nâng cấp M6".

### 11. Quota reserve/refund nguyên tử

```
reserve #1..#3: rows=1 used=1,2,3     reserve #4: rows=0  <= OVER QUOTA (429 rejected_quota)
refund      : 2      reserve again after refund: rows = 1
8 concurrent reserves, limit 3 -> granted = 3  rejected = 5  errors = 0
final used = 3 (đúng bằng 3)
```

`INSERT … ON CONFLICT DO UPDATE … WHERE used + n <= limit RETURNING` cho phép giữ hạn mức chính xác dưới tranh chấp mà không cần khoá tường minh.

### 12. Bẫy `pg.Client` khi backend bị giết

`pg_terminate_backend` làm `pg.Client` phát **`error` event**; không gắn handler ⇒ **`Unhandled 'error' event` giết cả tiến trình** (tái hiện được: script spike lần đầu chết đúng như vậy). Mọi client sống lâu (dispatcher lease, LISTEN) **bắt buộc** `client.on("error", …)`.

---

## File Structure

Tạo mới:

| File | Trách nhiệm |
|---|---|
| `apps/core/src/modules/orchestration/db/job-schema.ts` | `job_runs` (queue of record) + enum `job_status`, `job_lane`, `job_kind` |
| `apps/core/src/modules/orchestration/db/run-schema.ts` | `orc_runs`, `orc_run_plans`, `orc_compile_diagnostics` |
| `apps/core/src/modules/orchestration/db/fleet-schema.ts` | `orc_workers`, `orc_dispatcher_lease`, `orc_run_tokens`, `orc_run_events` |
| `apps/core/src/modules/orchestration/queue/job-queue.ts` | claim / heartbeat / complete / requeue — mọi câu SQL có epoch |
| `apps/core/src/modules/orchestration/queue/reaper.ts` | quét lease quá hạn ⇒ bump epoch + requeue đầu hàng team |
| `apps/core/src/modules/orchestration/dispatcher/lease.ts` | `orc_dispatcher_lease`: acquire/renew/release + dead-man |
| `apps/core/src/modules/orchestration/dispatcher/loop.ts` | vòng tick 250ms, fan-out ≤200, chỉ chạy khi giữ lease |
| `apps/core/src/modules/orchestration/run-service.ts` | phase 0: snapshot → compileRun → lưu plan → tạo job_runs |
| `apps/core/src/modules/orchestration/run-token.ts` | mint/verify run token (SHA-256, scope theo job+attempt+epoch) |
| `apps/core/src/modules/orchestration/internal/app.ts` | Fastify app riêng cho `/internal/fleet` + hook auth ba loại token |
| `apps/core/src/modules/orchestration/internal/routes.ts` | 7 endpoint `/internal/fleet/*` |
| `apps/core/src/modules/orchestration/events.ts` | ghi `orc_run_events` idempotent theo seq |
| `apps/core/src/modules/orchestration/routes.ts` | route `/v1/runs*` công khai (trigger, get, abort) |
| `apps/core/src/modules/orchestration/sse.ts` | `GET /v1/runs/{runId}/stream` — SSE trạng thái run |
| `apps/core/src/modules/results/db/schema.ts` | `res_case_results`, `res_step_results` (partition tháng), `res_artifacts` |
| `apps/core/src/modules/results/results-service.ts` | ghi kết quả theo attempt + đọc `MAX(attempt)` |
| `apps/core/src/modules/results/artifacts.ts` | cấp presigned PUT + ghi metadata |
| `apps/core/src/modules/results/s3/presign.ts` | SigV4 presign thuần `node:crypto` |
| `apps/core/src/modules/governance/quota.ts` | `reserveRunSlot` / `refundRunSlot` trên `usage_counters` |
| `apps/core/src/modules/governance/db/usage-schema.ts` | `usage_counters` |
| `packages/contract/src/routes/internal.ts` | descriptor + zod DTO của `/internal/fleet` (chia sẻ với `apps/runner`) |
| `packages/contract/src/routes/orchestration.ts` | descriptor route `/v1/runs*` |
| `apps/core/drizzle/NNNN_m3_*.sql` | migration (7 file, xem từng task) |
| `apps/core/test/orchestration/*.test.ts` | unit trên PGlite |
| `apps/core/test/concurrency/job-claim-race.test.ts` | tranh chấp thật trên Postgres |
| `apps/core/test/concurrency/lease-epoch-race.test.ts` | zombie + reaper trên Postgres |
| `apps/core/test/concurrency/dispatcher-leader.test.ts` | hai dispatcher, một leader, failover |
| `apps/core/test/results/*.test.ts` | partition, MAX(attempt), presign |
| `apps/core/test/harness/internal.ts` | harness dựng `/internal` + fleet token + run token |

Sửa: `packages/contract/src/errors.ts` (thêm `StaleEpochError`, `JobTerminalError`), `packages/contract/src/routes/index.ts` (nối `orchestrationRoutes`), `packages/contract/src/index.ts` (export schema mới), `apps/core/src/modules/orchestration/index.ts` + `results/index.ts` + `governance/index.ts` (facade), `apps/core/src/composition-root.ts` (wiring), `apps/core/src/modules/kernel/env.ts` (biến env mới), `apps/core/test/isolation/fixtures.ts` (fixture L3), `testkite/tasks/M3-orchestration-fleet.md` (tick).

---

## Task 1 — `orc_runs` + `orc_run_plans` + `orc_compile_diagnostics` (aggregate của một lần chạy)

Bảng `job_runs` trỏ vào `orc_runs` bằng composite FK, nên run aggregate phải ra đời trước.

**Files:**
- Create: `apps/core/src/modules/orchestration/db/run-schema.ts`
- Create: `apps/core/drizzle/NNNN_m3_orc_runs_grants.sql` (viết tay)
- Create: `apps/core/test/orchestration/run-schema.test.ts`
- Modify: `apps/core/src/modules/orchestration/index.ts` (facade export)

**Interfaces:**
- Produces: `orcRuns`, `orcRunPlans`, `orcCompileDiagnostics` (drizzle table); `runStatus`, `runVerdict`, `runLane` (pgEnum). Cột `orc_runs`: `teamId, id, projectId, lane, status, verdict, planHash, requestedBy, pin, startedAt, finishedAt, chainTotal, chainDone, createdAt`. Cột `orc_run_plans`: `teamId, id, runId, contentHash, planFormatVersion, plan (jsonb), createdAt`. Cột `orc_compile_diagnostics`: `teamId, id, runId, severity, code, caseId, stepOrdinal, message`.

- [x] **Step 1: Viết test ĐỎ cho hình dạng bảng + RLS**

```ts
// apps/core/test/orchestration/run-schema.test.ts
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

describe("orc_runs / orc_run_plans / orc_compile_diagnostics", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await makeTestDb();
  });

  it("keeps team_id leading on every index and UNIQUE(team_id, id) on every table", async () => {
    const r = await t.db.execute(sql`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE tablename IN ('orc_runs','orc_run_plans','orc_compile_diagnostics')`);
    const defs = r.rows.map((row) => String(row["indexdef"]));
    for (const table of ["orc_runs", "orc_run_plans", "orc_compile_diagnostics"]) {
      expect(defs.some((d) => d.includes(`ON public.${table}`) && /\(team_id, id\)/.test(d)),
        `${table} is missing UNIQUE(team_id, id)`).toBe(true);
    }
    // A btree index that does not start with team_id makes a cross-tenant scan cheap.
    const nonLeading = defs.filter((d) => /USING btree \((?!team_id)/.test(d) && !d.includes("_pkey"));
    expect(nonLeading, "every btree index must lead with team_id").toEqual([]);
  });

  it("refuses a run plan that points at another team's run (composite FK, layer L2)", async () => {
    const [a, b] = await t.seedTwoTeams();
    const run = await t.db.execute(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${a.teamId}, ${a.projectId}, 'batch', ${a.userId}, 'ready') RETURNING id`);
    const runId = String(run.rows[0]?.["id"]);
    await expect(
      t.db.execute(sql`
        INSERT INTO orc_run_plans (team_id, run_id, content_hash, plan_format_version, plan)
        VALUES (${b.teamId}, ${runId}, ${"0".repeat(64)}, 1, '{}'::jsonb)`),
    ).rejects.toThrow(/foreign key/i);
  });

  it("hides another team's run behind RLS instead of returning 403 material", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.db.execute(sql`
      INSERT INTO orc_runs (team_id, project_id, lane, requested_by, pin)
      VALUES (${a.teamId}, ${a.projectId}, 'batch', ${a.userId}, 'ready')`);
    const seenByB = await t.asTeam(b.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_runs`));
    expect(Number(seenByB.rows[0]?.["n"])).toBe(0);
  });

  it("keeps a frozen plan immutable: the app role has no UPDATE or DELETE on orc_run_plans", async () => {
    const r = await t.db.execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'orc_run_plans' AND grantee = 'testkite_app' ORDER BY privilege_type`);
    expect(r.rows.map((x) => String(x["privilege_type"]))).toEqual(["INSERT", "SELECT"]);
  });
});
```

`makeTestDb()` hiện chưa có `seedTwoTeams`/`asTeam`. Thêm chúng vào `apps/core/test/harness/pglite.ts` trong bước này (một helper, dùng lại cho mọi task sau):

```ts
// apps/core/test/harness/pglite.ts — append to the TestDb surface
export type SeededTeam = { teamId: string; projectId: string; userId: string };

// Two fully-formed tenants + one user each. Every isolation test in M3 starts from here
// instead of re-inventing its own fixture (and quietly disagreeing about the shape).
async function seedTwoTeams(db: TkDb): Promise<[SeededTeam, SeededTeam]> { /* org, teams, projects, users, memberships */ }
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-schema.test.ts`
Expected: FAIL — `relation "orc_runs" does not exist`.

- [x] **Step 3: Viết schema drizzle**

```ts
// apps/core/src/modules/orchestration/db/run-schema.ts
/**
 * Module orchestration — the run aggregate (ownership.json: orc_*).
 *
 * `orc_run_plans` is APPEND-ONLY AT THE PRIVILEGE LAYER (see the grants migration): a frozen
 * plan is the only thing the worker ever executes, so "immutable" cannot be a convention that
 * code happens to respect — the database has to refuse the UPDATE.
 */
import { sql } from "drizzle-orm";
import {
  foreignKey, index, integer, jsonb, pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";
import { projects, users } from "../../identity/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const runLane = pgEnum("run_lane", ["interactive", "batch"]);
export const runStatus = pgEnum("run_status", ["compiling", "queued", "running", "finished"]);
export const runVerdict = pgEnum("run_verdict", [
  "pending", "passed", "failed", "compile_error", "blocked", "aborted_early", "cancelled",
]);
export const runPin = pgEnum("run_pin", ["ready", "latest"]);
export const diagnosticSeverity = pgEnum("diagnostic_severity", ["error", "warning"]);

export const orcRuns = pgTable(
  "orc_runs",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    lane: runLane("lane").notNull().default("batch"),
    status: runStatus("status").notNull().default("compiling"),
    verdict: runVerdict("verdict").notNull().default("pending"),
    /** NULL until phase 7 froze a plan; absent forever when verdict = compile_error. */
    planHash: text("plan_hash"),
    requestedBy: uuid("requested_by").notNull(),
    pin: runPin("pin").notNull(),
    chainTotal: integer("chain_total").notNull().default(0),
    chainDone: integer("chain_done").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_runs_team_id_unique").on(t.teamId, t.id),
    index("orc_runs_team_created_idx").on(t.teamId, t.createdAt.desc()),
    index("orc_runs_team_status_idx").on(t.teamId, t.status, t.createdAt.desc()),
    foreignKey({
      name: "orc_runs_project_fk",
      columns: [t.teamId, t.projectId],
      foreignColumns: [projects.teamId, projects.id],
    }),
    foreignKey({ name: "orc_runs_user_fk", columns: [t.requestedBy], foreignColumns: [users.id] }),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

export const orcRunPlans = pgTable(
  "orc_run_plans",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    /** Lowercase SHA-256 hex from the compiler's phase 7 — the plan's identity. */
    contentHash: text("content_hash").notNull(),
    planFormatVersion: integer("plan_format_version").notNull(),
    plan: jsonb("plan").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_run_plans_team_id_unique").on(t.teamId, t.id),
    unique("orc_run_plans_team_run_unique").on(t.teamId, t.runId),
    index("orc_run_plans_team_hash_idx").on(t.teamId, t.contentHash),
    foreignKey({
      name: "orc_run_plans_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
  ],
).enableRLS();

export const orcCompileDiagnostics = pgTable(
  "orc_compile_diagnostics",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    severity: diagnosticSeverity("severity").notNull(),
    code: text("code").notNull(),
    caseId: text("case_id").notNull(),
    stepOrdinal: integer("step_ordinal"),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_compile_diagnostics_team_id_unique").on(t.teamId, t.id),
    index("orc_compile_diagnostics_team_run_idx").on(t.teamId, t.runId),
    foreignKey({
      name: "orc_compile_diagnostics_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

- [x] **Step 4: Sinh migration + viết migration GRANT bằng tay**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_orc_runs
```

Sau đó tạo file kế tiếp (số do `_journal.json` quyết định, TAG là `m3_orc_runs_grants`):

```sql
-- The part drizzle-kit does NOT generate: GRANT. RLS only filters rows AFTER the role has
-- table privileges; without the GRANT the app role gets "permission denied", which is not fail-closed.
GRANT SELECT, INSERT, UPDATE ON orc_runs TO "testkite_app";
--> statement-breakpoint
-- APPEND-ONLY: a frozen plan is what the worker executes and what the content hash names.
-- No UPDATE, no DELETE — the DB refuses, we do not merely avoid calling it.
GRANT SELECT, INSERT ON orc_run_plans TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON orc_compile_diagnostics TO "testkite_app";
```

Thêm entry vào `apps/core/drizzle/meta/_journal.json` (`idx` kế tiếp, `version: "7"`, `when` = epoch ms hiện tại, `tag` = tên file không đuôi, `breakpoints: true`).

- [x] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-schema.test.ts`
Expected: PASS 4 test.

- [x] **Step 6: Export facade + commit**

Thêm vào `apps/core/src/modules/orchestration/index.ts`:

```ts
export { orcRuns, orcRunPlans, orcCompileDiagnostics, runLane, runStatus, runVerdict, runPin } from "./db/run-schema.js";
```

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src/modules/orchestration testkite/apps/core/drizzle testkite/apps/core/test
git commit -m "M3-ORC T1: orc_runs + orc_run_plans + compile diagnostics (RLS, composite FK, append-only plan)"
```

---

## Task 2 — `job_runs`: queue of record + role `testkite_dispatch`

**Files:**
- Create: `apps/core/src/modules/orchestration/db/job-schema.ts`
- Create: `apps/core/drizzle/NNNN_m3_job_runs_grants.sql` (viết tay: role, partial index, GRANT)
- Create: `apps/core/test/orchestration/job-runs-schema.test.ts`
- Modify: `apps/core/src/modules/kernel/db/schema.ts` (thêm `DISPATCH_ROLE`/`dispatchRole` — **thêm vào CUỐI khối role, không đụng dòng nào khác**)
- Modify: `apps/core/src/modules/kernel/db/tenant.ts` (thêm `withDispatchRole`)
- Modify: `apps/core/src/modules/kernel/index.ts` (export hai thứ trên)

**Interfaces:**
- Consumes: `orcRuns` (Task 1), `appRole` (kernel).
- Produces: `jobRuns` (drizzle table); `jobStatus`, `jobKind` (pgEnum); `DISPATCH_ROLE = "testkite_dispatch"`, `dispatchRole`; `withDispatchRole<T>(db: TkDb, fn: (tx: TkTx) => Promise<T>): Promise<T>`.

- [x] **Step 1: Viết test ĐỎ — RLS hai role + fail-closed + không được kế thừa role**

```ts
// apps/core/test/orchestration/job-runs-schema.test.ts
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

describe("job_runs — queue of record", () => {
  let t: TestDb;
  beforeAll(async () => { t = await makeTestDb(); });

  it("shows the request path only its own team's jobs", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.seedJobs(a, 3);
    await t.seedJobs(b, 2);
    const seen = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM job_runs`));
    expect(Number(seen.rows[0]?.["n"])).toBe(3);
  });

  it("returns nothing at all when app.team_id was never set (fail-closed)", async () => {
    const seen = await t.asAppRoleWithoutTenant((tx) => tx.execute(sql`SELECT count(*)::int n FROM job_runs`));
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });

  it("lets the dispatch role read across teams — that is the whole point of the claim path", async () => {
    const seen = await t.asDispatchRole((tx) => tx.execute(sql`SELECT count(*)::int n FROM job_runs`));
    expect(Number(seen.rows[0]?.["n"])).toBe(5);
  });

  it("never lets the dispatch role create a job", async () => {
    await expect(
      t.asDispatchRole((tx) => tx.execute(sql`INSERT INTO job_runs (team_id, run_id, chain_key, queue_seq)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 1)`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it("does NOT grant the dispatch role to the app role (permissive policies OR across inherited roles)", async () => {
    // Spike 2026-08-29: granting testkite_dispatch to testkite_app made team A see all 5 rows.
    const r = await t.db.execute(sql`
      SELECT count(*)::int n FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
      WHERE granted.rolname = 'testkite_dispatch' AND member.rolname = 'testkite_app'`);
    expect(Number(r.rows[0]?.["n"])).toBe(0);
  });

  it("has one partial index for the dispatcher (no lane) and one for the worker claim (lane first)", async () => {
    const r = await t.db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'job_runs'`);
    const defs = r.rows.map((x) => String(x["indexdef"]));
    // The dispatcher orders by (priority DESC, queue_seq) with no lane filter: an index whose
    // leading column is `lane` is unusable there — measured 10.007ms seq scan vs 0.205ms index scan.
    expect(defs.some((d) => /\(priority DESC, queue_seq\).*WHERE \(status = 'pending'/.test(d))).toBe(true);
    expect(defs.some((d) => /\(lane, priority DESC, queue_seq\).*WHERE \(status = 'dispatched'/.test(d))).toBe(true);
    expect(defs.some((d) => /\(lease_expires_at\).*WHERE \(status = 'running'/.test(d))).toBe(true);
  });

  it("cannot attach a job to another team's run", async () => {
    const [a, b] = await t.seedTwoTeams();
    const run = await t.seedRun(a);
    await expect(
      t.db.execute(sql`INSERT INTO job_runs (team_id, run_id, chain_key, queue_seq)
        VALUES (${b.teamId}, ${run}, 'chain-1', nextval('job_runs_queue_seq'))`),
    ).rejects.toThrow(/foreign key/i);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/job-runs-schema.test.ts`
Expected: FAIL — `relation "job_runs" does not exist`.

- [x] **Step 3: Thêm role dispatch vào kernel**

Trong `apps/core/src/modules/kernel/db/schema.ts`, **ngay sau** khối `AUTH_ROLE` (cuối danh sách role, không chèn giữa):

```ts
/**
 * Role for the DISPATCH PATH (dispatcher tick + worker claim through /internal).
 *
 * It reads and updates job_runs ACROSS every tenant — that is inherent to a queue: the
 * dispatcher does not know whose job is next until it looks. Two guardrails make that safe:
 *   1. It has SELECT + UPDATE on job_runs and NOTHING else. It cannot create a job, cannot
 *      read a case, a revision, a secret, or a result.
 *   2. It is NEVER granted to testkite_app. Spike 2026-08-29 measured that permissive
 *      policies are OR-ed across INHERITED roles: `GRANT testkite_dispatch TO testkite_app`
 *      made a team-A session read all 5 rows of both teams. job-runs-schema.test.ts asserts
 *      the membership does not exist.
 */
export const DISPATCH_ROLE = "testkite_dispatch" as const;
export const dispatchRole = pgRole(DISPATCH_ROLE);
```

Trong `apps/core/src/modules/kernel/db/tenant.ts`, thêm cuối file:

```ts
/**
 * Transaction for the DISPATCH PATH: `SET LOCAL ROLE testkite_dispatch`, and deliberately
 * does NOT set `app.team_id` — the tenant is the ANSWER of the claim query, not its input.
 * Everything after the claim (writing results, minting a run token) runs through withTenant()
 * with the team_id the claim just returned.
 */
export async function withDispatchRole<T>(db: TkDb, fn: (tx: TkTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // DISPATCH_ROLE is our own compile-time constant, not user input.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${DISPATCH_ROLE}`));
    return fn(tx);
  });
}
```

- [x] **Step 4: Viết schema `job_runs`**

```ts
// apps/core/src/modules/orchestration/db/job-schema.ts
/**
 * `job_runs` — THE QUEUE OF RECORD (blueprint §5). There is no second queue: no Redis list,
 * no BullMQ job for test execution. A row here is the single truth about who owns a chain
 * right now, and `lease_epoch` is the fence that makes ownership provable.
 *
 * Ordering key = (priority DESC, queue_seq ASC, id ASC). `id` is in the key ONLY as a
 * tiebreak: requeue-at-team-head computes MIN(queue_seq)-1, and two reapers racing would
 * produce a tie (measured, spike 2026-08-29 §4). The reaper only ever runs inside the
 * leader's tick, so a tie should not happen — the tiebreak makes the order deterministic
 * even if it somehow does.
 */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, foreignKey, index, integer, pgEnum, pgPolicy, pgTable, text,
  timestamp, unique, uuid,
} from "drizzle-orm/pg-core";
import { appRole, dispatchRole } from "../../kernel/index.js";
import { orcRuns } from "./run-schema.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const jobStatus = pgEnum("job_status", [
  "pending", "dispatched", "running", "succeeded", "failed", "cancelled",
  "rejected_quota", "unknown_after_restore",
]);
export const jobKind = pgEnum("job_kind", ["chain", "element_verify", "capture_session", "env_probe"]);

export const jobRuns = pgTable(
  "job_runs",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    chainKey: text("chain_key").notNull(),
    lane: text("lane").notNull().default("batch"),
    jobKind: jobKind("job_kind").notNull().default("chain"),
    status: jobStatus("status").notNull().default("pending"),
    /** Bumped on EVERY ownership change. A worker holding an older value writes 0 rows ⇒ 409. */
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    /** Ordering position. Requeue rewrites it to MIN(queue_seq)-1 within the team. */
    queueSeq: bigint("queue_seq", { mode: "number" }).notNull(),
    /** cost = clamp(ceil(steps/10), 1, 8) — stamped at compile time, read by the M5 DRR. */
    cost: integer("cost").notNull().default(1),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /**
     * Quarantine after 2 OOM (blueprint §5) is a COLUMN, not a status: a quarantined job is
     * still `pending` for every read path, it is only invisible to the dispatcher. Adding an
     * enum value would have rippled into the contract's JOB_STATUSES and the run DTO.
     */
    oomCount: integer("oom_count").notNull().default(0),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("job_runs_team_id_unique").on(t.teamId, t.id),
    unique("job_runs_team_run_chain_unique").on(t.teamId, t.runId, t.chainKey),
    index("job_runs_team_run_idx").on(t.teamId, t.runId, t.status),
    foreignKey({
      name: "job_runs_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [orcRuns.teamId, orcRuns.id],
    }),
    check("job_runs_lane_check", sql`${t.lane} IN ('interactive','batch')`),
    check("job_runs_attempt_check", sql`${t.attempt} >= 1`),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
    // The claim path does not know the tenant yet — see withDispatchRole().
    pgPolicy("dispatch_all", { as: "permissive", for: "all", to: dispatchRole, using: sql`true`, withCheck: sql`true` }),
  ],
).enableRLS();
```

- [x] **Step 5: Sinh migration + viết migration tay cho role/index/GRANT**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_job_runs
```

File viết tay kế tiếp, TAG `m3_job_runs_grants`:

```sql
-- drizzle-kit emits CREATE ROLE but not the role's ATTRIBUTES, not a partial index with DESC,
-- and not GRANT. Those three are handwritten here (same pattern as 0002/0004/0016 in M1/M2).
ALTER ROLE "testkite_dispatch" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO "testkite_dispatch";
--> statement-breakpoint
-- Ordering counter for the queue. A plain sequence (not per-team) is enough: requeue moves a
-- job to MIN(queue_seq)-1 WITHIN its team, so the global counter only supplies monotonicity.
CREATE SEQUENCE IF NOT EXISTS job_runs_queue_seq;
--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "queue_seq" SET DEFAULT nextval('job_runs_queue_seq');
--> statement-breakpoint
GRANT USAGE ON SEQUENCE job_runs_queue_seq TO "testkite_app";
--> statement-breakpoint
-- Dispatcher scan: NO lane filter, so the index must NOT start with lane.
-- Measured 2026-08-29 on 20k pending rows: wrong index = 10.007ms seq scan, this one = 0.205ms.
CREATE INDEX "job_runs_pending_idx" ON "job_runs" ("priority" DESC, "queue_seq") WHERE "status" = 'pending';
--> statement-breakpoint
-- Worker claim: always lane-scoped, so lane leads here.
CREATE INDEX "job_runs_ready_idx" ON "job_runs" ("lane", "priority" DESC, "queue_seq") WHERE "status" = 'dispatched';
--> statement-breakpoint
-- Reaper: measured 0.010ms on the same 20k rows.
CREATE INDEX "job_runs_lease_idx" ON "job_runs" ("lease_expires_at") WHERE "status" = 'running';
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "job_runs" TO "testkite_app";
--> statement-breakpoint
-- The dispatch path moves jobs; it never creates or deletes one. No INSERT, no DELETE.
GRANT SELECT, UPDATE ON "job_runs" TO "testkite_dispatch";
```

Thêm entry `_journal.json` cho cả hai file.

- [x] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/job-runs-schema.test.ts`
Expected: PASS 7 test.

- [x] **Step 7: Commit**

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src testkite/apps/core/drizzle testkite/apps/core/test
git commit -m "M3-ORC T2: job_runs queue of record + role testkite_dispatch + partial index dispatcher/claim/reaper"
```

---

## Task 3 — Quota: `usage_counters` + reserve/refund nguyên tử

Phase 0 phải **giữ chỗ** quota trước khi compile và **hoàn** lại khi compile hỏng. Không có bước này thì "diagnostics ⇒ compile_error, hoàn quota" là câu nói suông.

**Files:**
- Create: `apps/core/src/modules/governance/db/usage-schema.ts`
- Create: `apps/core/src/modules/governance/quota.ts`
- Create: `apps/core/drizzle/NNNN_m3_usage_counters_grants.sql` (viết tay)
- Create: `apps/core/test/governance/quota.test.ts`
- Modify: `apps/core/src/modules/governance/index.ts` (facade)

**Interfaces:**
- Produces: `usageCounters` (drizzle table); `reserveRunSlot(tx: TkTx, ctx: TenantContext, input: { now: Date; amount?: number }): Promise<{ granted: boolean; used: number; limit: number }>`; `refundRunSlot(tx: TkTx, ctx: TenantContext, input: { now: Date; amount?: number }): Promise<void>`; `QUOTA_METRIC_RUNS_PER_DAY = "runs_per_day"`.

- [x] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/governance/quota.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { refundRunSlot, reserveRunSlot } from "../../src/modules/governance/quota.js";

describe("run quota reserve/refund", () => {
  let t: TestDb;
  const now = new Date("2026-08-30T09:00:00Z");
  beforeEach(async () => { t = await makeTestDb(); });

  it("grants up to the team's max_runs_per_day and then refuses", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 3 WHERE team_id = ${a.teamId}`);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now })));
    }
    expect(results.map((r) => r.granted)).toEqual([true, true, true, false]);
    expect(results[2]?.used).toBe(3);
  });

  it("gives the slot back when compilation fails, so a broken test does not burn the day's budget", async () => {
    const [a] = await t.seedTwoTeams();
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 1 WHERE team_id = ${a.teamId}`);
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect((await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }))).granted).toBe(false);
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    expect((await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }))).granted).toBe(true);
  });

  it("never lets a refund push the counter below zero", async () => {
    const [a] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => refundRunSlot(tx, ctx, { now }));
    const r = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT coalesce(max(used), 0)::int u FROM usage_counters`));
    expect(Number(r.rows[0]?.["u"])).toBe(0);
  });

  it("counts each team's runs separately", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.asTeamCtx(a.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    const forB = await t.asTeamCtx(b.teamId, (tx, ctx) => reserveRunSlot(tx, ctx, { now }));
    expect(forB.used).toBe(1);
  });
});
```

- [x] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/governance/quota.test.ts`
Expected: FAIL — `Cannot find module '.../governance/quota.js'`.

- [x] **Step 3: Schema + hàm**

```ts
// apps/core/src/modules/governance/db/usage-schema.ts
/**
 * Module governance — usage_counters (ownership.json). M3 only needs ONE metric
 * (runs_per_day); the usage_ledger and the reservation model for concurrent contexts are M5.
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appRole } from "../../kernel/index.js";

const tenantPredicate = sql`team_id = NULLIF(current_setting('app.team_id', true), '')::uuid`;

export const usageCounters = pgTable(
  "usage_counters",
  {
    teamId: uuid("team_id").notNull(),
    metric: text("metric").notNull(),
    /** UTC day for runs_per_day; M5 will add month-windowed metrics on the same shape. */
    windowStart: date("window_start").notNull(),
    used: integer("used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.metric, t.windowStart] }),
    index("usage_counters_team_idx").on(t.teamId, t.metric, t.windowStart),
    check("usage_counters_used_check", sql`${t.used} >= 0`),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

```ts
// apps/core/src/modules/governance/quota.ts
/**
 * Reserve BEFORE compiling, refund when compilation fails. The whole guarantee lives in one
 * statement: `ON CONFLICT DO UPDATE ... WHERE used + n <= limit RETURNING used`. Measured
 * 2026-08-29 with 8 concurrent reservations against a limit of 3: exactly 3 granted, 5
 * refused, 0 errors — no explicit locking, no read-then-write race.
 */
import { sql } from "drizzle-orm";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";

export const QUOTA_METRIC_RUNS_PER_DAY = "runs_per_day" as const;

export interface ReserveResult {
  readonly granted: boolean;
  readonly used: number;
  readonly limit: number;
}

const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export async function reserveRunSlot(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly now: Date; readonly amount?: number },
): Promise<ReserveResult> {
  const teamId = assertTenantContext(ctx);
  const amount = input.amount ?? 1;
  const limitRow = await tx.execute(
    sql`SELECT max_runs_per_day AS lim FROM quota_limits WHERE team_id = ${teamId}`,
  );
  // No quota row at all = the team was never onboarded through the real path. Refuse rather
  // than invent a default: a missing limit must not become an unlimited one.
  const limit = Number(limitRow.rows[0]?.["lim"] ?? 0);
  const res = await tx.execute(sql`
    INSERT INTO usage_counters (team_id, metric, window_start, used)
    VALUES (${teamId}, ${QUOTA_METRIC_RUNS_PER_DAY}, ${utcDay(input.now)}, ${amount})
    ON CONFLICT (team_id, metric, window_start) DO UPDATE
      SET used = usage_counters.used + EXCLUDED.used, updated_at = now()
      WHERE usage_counters.used + EXCLUDED.used <= ${limit}
    RETURNING used`);
  const row = res.rows[0];
  if (row === undefined) return { granted: false, used: limit, limit };
  return { granted: true, used: Number(row["used"]), limit };
}

export async function refundRunSlot(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly now: Date; readonly amount?: number },
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  const amount = input.amount ?? 1;
  // GREATEST(...,0): a double refund (retry of an error path) must not mint free quota.
  await tx.execute(sql`
    UPDATE usage_counters SET used = GREATEST(used - ${amount}, 0), updated_at = now()
    WHERE team_id = ${teamId} AND metric = ${QUOTA_METRIC_RUNS_PER_DAY}
      AND window_start = ${utcDay(input.now)}`);
}
```

- [x] **Step 4: Migration**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_usage_counters
```

TAG `m3_usage_counters_grants`:

```sql
GRANT SELECT, INSERT, UPDATE ON usage_counters TO "testkite_app";
```

- [x] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/governance/quota.test.ts`
Expected: PASS 4 test.

- [x] **Step 6: Facade + commit**

```ts
// apps/core/src/modules/governance/index.ts — append
export { usageCounters } from "./db/usage-schema.js";
export { reserveRunSlot, refundRunSlot, QUOTA_METRIC_RUNS_PER_DAY, type ReserveResult } from "./quota.js";
```

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src/modules/governance testkite/apps/core/drizzle testkite/apps/core/test/governance
git commit -m "M3-ORC T3: usage_counters + reserve/refund quota nguyen tu cho phase 0"
```

---

## Task 4 — Phase 0: snapshot → `compileRun` → lưu plan bất biến → sinh `job_runs`

Đây là chỗ *duy nhất* nối authoring + planning + compiler + queue. Điều kiện đúng đắn quan trọng nhất: **có `severity: "error"` ⇒ không một `job_runs` nào ra đời, quota được hoàn, không có browser nào khởi động.**

**Files:**
- Create: `apps/core/src/modules/orchestration/run-service.ts`
- Create: `apps/core/src/modules/planning/environment.ts` (facade `loadRunEnvironment`)
- Create: `apps/core/test/orchestration/run-service.test.ts`
- Modify: `apps/core/src/modules/planning/index.ts`, `apps/core/src/modules/orchestration/index.ts`

**Interfaces:**
- Consumes: `buildCompileSnapshot(tx, ctx, input, deps)` + `SnapshotDeps`/`SnapshotPin` (authoring facade); `compileRun(input): CompileOutput`, `countSteps`, `PLAN_FORMAT_VERSION` (`@testkite/run-compiler`); `reserveRunSlot`/`refundRunSlot` (governance facade); `orcRuns`/`orcRunPlans`/`orcCompileDiagnostics`/`jobRuns` (Task 1, 2).
- Produces:
```ts
export interface StartRunInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly lane: "interactive" | "batch";
  readonly pin: "ready" | "latest";
  readonly requestedBy: string;
  readonly screenshots?: "all" | "failure" | "none";
  readonly now: Date;
}
export interface StartRunDeps {
  readonly loadElements: SnapshotDeps["loadElements"];
  readonly loadDataProfiles: SnapshotDeps["loadDataProfiles"];
}
export type StartRunResult =
  | { readonly kind: "queued"; readonly runId: string; readonly planHash: string; readonly chainCount: number }
  | { readonly kind: "compile_error"; readonly runId: string; readonly diagnostics: readonly CompileDiagnostic[] }
  | { readonly kind: "rejected_quota"; readonly used: number; readonly limit: number };
export declare function startRun(tx: TkTx, ctx: TenantContext, input: StartRunInput, deps: StartRunDeps): Promise<StartRunResult>;
export declare const JOB_COST_MAX = 8;
export declare function jobCost(stepCount: number): number;   // clamp(ceil(steps/10), 1, 8)
```
- `loadRunEnvironment(tx: TkTx, ctx: TenantContext, projectId: string): Promise<EnvDto>` (planning facade).

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/run-service.test.ts
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { startRun, jobCost } from "../../src/modules/orchestration/run-service.js";

const DEPS = { loadElements: async () => ({}), loadDataProfiles: async () => ({}) };
const now = new Date("2026-08-30T09:00:00Z");

describe("startRun — compiler phase 0", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("freezes one plan and creates exactly one job_run per chain", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 2);           // two independent chains
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      startRun(tx, ctx, { projectId: a.projectId, targetCaseIds: caseIds, lane: "batch",
        pin: "latest", requestedBy: a.userId, now }, DEPS));
    expect(res.kind).toBe("queued");
    const jobs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, chain_key, cost FROM job_runs ORDER BY chain_key`));
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.every((r) => r["status"] === "pending")).toBe(true);
    const plan = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT content_hash, plan_format_version FROM orc_run_plans`));
    expect(String(plan.rows[0]?.["content_hash"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: compiling the same cases twice yields the same content_hash", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 1);
    const first = await t.asTeamCtx(a.teamId, (tx, ctx) => startRun(tx, ctx, { projectId: a.projectId,
      targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now }, DEPS));
    const second = await t.asTeamCtx(a.teamId, (tx, ctx) => startRun(tx, ctx, { projectId: a.projectId,
      targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now }, DEPS));
    expect(first.kind === "queued" && second.kind === "queued" && first.planHash === second.planHash).toBe(true);
  });

  it("creates NO job at all when the compiler reports an error, and refunds the quota", async () => {
    const [a] = await t.seedTwoTeams();
    const broken = await t.seedCaseWithPendingLocator(a);      // element_pending_locator
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 1 WHERE team_id = ${a.teamId}`);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => startRun(tx, ctx, { projectId: a.projectId,
      targetCaseIds: [broken], lane: "batch", pin: "latest", requestedBy: a.userId, now }, DEPS));
    expect(res.kind).toBe("compile_error");
    const jobs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM job_runs`));
    expect(Number(jobs.rows[0]?.["n"]), "a compile error must never queue work").toBe(0);
    const run = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, verdict, plan_hash FROM orc_runs`));
    expect(run.rows[0]).toMatchObject({ status: "finished", verdict: "compile_error", plan_hash: null });
    const diags = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT code FROM orc_compile_diagnostics`));
    expect(diags.rows.map((r) => String(r["code"]))).toContain("element_pending_locator");
    // The quota went back: a second run on the same day is still allowed.
    const used = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT used FROM usage_counters`));
    expect(Number(used.rows[0]?.["used"])).toBe(0);
  });

  it("refuses over-quota BEFORE compiling anything", async () => {
    const [a] = await t.seedTwoTeams();
    const caseIds = await t.seedRunnableCases(a, 1);
    await t.db.execute(sql`UPDATE quota_limits SET max_runs_per_day = 0 WHERE team_id = ${a.teamId}`);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => startRun(tx, ctx, { projectId: a.projectId,
      targetCaseIds: caseIds, lane: "batch", pin: "latest", requestedBy: a.userId, now }, DEPS));
    expect(res.kind).toBe("rejected_quota");
    const runs = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM orc_runs`));
    expect(Number(runs.rows[0]?.["n"])).toBe(0);
  });

  it("404s a case belonging to another team instead of leaking its existence", async () => {
    const [a, b] = await t.seedTwoTeams();
    const foreign = (await t.seedRunnableCases(b, 1))[0] ?? "";
    await expect(
      t.asTeamCtx(a.teamId, (tx, ctx) => startRun(tx, ctx, { projectId: a.projectId,
        targetCaseIds: [foreign], lane: "batch", pin: "latest", requestedBy: a.userId, now }, DEPS)),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("computes job cost as clamp(ceil(steps/10), 1, 8)", () => {
    expect([jobCost(0), jobCost(1), jobCost(10), jobCost(11), jobCost(80), jobCost(500)]).toEqual([1, 1, 1, 2, 8, 8]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-service.test.ts`
Expected: FAIL — `Cannot find module '.../orchestration/run-service.js'`.

- [ ] **Step 3: Facade môi trường của planning**

```ts
// apps/core/src/modules/planning/environment.ts
/**
 * The compiler needs base_url + vars + the NAMES of the available secrets (never a value).
 * planning sits AFTER authoring and BEFORE orchestration in the DAG, so orchestration
 * calling this is a forward call; authoring receiving the result as a parameter is why
 * buildCompileSnapshot takes `env` instead of importing planning.
 */
import { sql } from "drizzle-orm";
import { NotFoundError, type EnvDto } from "@testkite/contract";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";

/** Extends NotFoundError so the shared HTTP error handler maps it to 404, never 403. */
export class EnvironmentNotFoundError extends NotFoundError {}

export async function loadRunEnvironment(tx: TkTx, ctx: TenantContext, projectId: string): Promise<EnvDto> {
  assertTenantContext(ctx);
  // RLS already scoped this to the tenant, so "not visible" and "not there" are the same
  // answer on purpose — the caller turns both into 404 (blueprint §3 L3).
  const r = await tx.execute(sql`
    SELECT base_url FROM pln_environments
    WHERE project_id = ${projectId} AND status <> 'archived'
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name LIMIT 1`);
  const row = r.rows[0];
  if (row === undefined) throw new EnvironmentNotFoundError(`no environment for project ${projectId}`);
  // M4 adds vars + secret_refs; until then a run has no env vars and no secrets, and the
  // compiler's `secret_ref_unknown` diagnostic is what tells the author so.
  return { baseUrl: String(row["base_url"]), vars: {}, secretNames: [] };
}
```

- [ ] **Step 4: `run-service.ts`**

```ts
// apps/core/src/modules/orchestration/run-service.ts
/**
 * Compiler pipeline, phase 0 and phases 8-9's entry point (blueprint §4).
 *
 * Phase 0 = admission: reserve quota, open the run row, gather the snapshot. Phases 1-7 are
 * the PURE compiler (@testkite/run-compiler) — this file does the I/O so that function never
 * has to. Phase 8 = dispatch: one job_runs row per chain. Phase 9 (execution) happens on the
 * worker and reports back through /internal.
 *
 * The whole thing runs in ONE transaction. Either a run exists with a frozen plan and its
 * jobs, or nothing happened at all. A half-created run whose jobs are missing would sit in
 * the queue forever, and a job without a plan would kill a worker on claim.
 */
import { sql } from "drizzle-orm";
import { NotFoundError } from "@testkite/contract";
import { compileRun, countSteps, PLAN_FORMAT_VERSION, type CompileDiagnostic } from "@testkite/run-compiler";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";
import { buildCompileSnapshot, type SnapshotDeps } from "../authoring/index.js";
import { refundRunSlot, reserveRunSlot } from "../governance/index.js";
import { loadRunEnvironment } from "../planning/index.js";

export const JOB_COST_MAX = 8;

/** Dispatcher cost model (blueprint §5): a 200-step chain must not count the same as a 3-step one. */
export function jobCost(stepCount: number): number {
  return Math.min(Math.max(Math.ceil(stepCount / 10), 1), JOB_COST_MAX);
}

export interface StartRunInput {
  readonly projectId: string;
  readonly targetCaseIds: readonly string[];
  readonly lane: "interactive" | "batch";
  readonly pin: "ready" | "latest";
  readonly requestedBy: string;
  readonly screenshots?: "all" | "failure" | "none";
  readonly now: Date;
}

export interface StartRunDeps {
  readonly loadElements: SnapshotDeps["loadElements"];
  readonly loadDataProfiles: SnapshotDeps["loadDataProfiles"];
}

export type StartRunResult =
  | { readonly kind: "queued"; readonly runId: string; readonly planHash: string; readonly chainCount: number }
  | { readonly kind: "compile_error"; readonly runId: string; readonly diagnostics: readonly CompileDiagnostic[] }
  | { readonly kind: "rejected_quota"; readonly used: number; readonly limit: number };

export async function startRun(
  tx: TkTx,
  ctx: TenantContext,
  input: StartRunInput,
  deps: StartRunDeps,
): Promise<StartRunResult> {
  const teamId = assertTenantContext(ctx);

  // ---- phase 0a: admission. Reserve FIRST: compiling a 200-case chain for a team that has
  // no budget left is work nobody asked for.
  const quota = await reserveRunSlot(tx, ctx, { now: input.now });
  if (!quota.granted) return { kind: "rejected_quota", used: quota.used, limit: quota.limit };

  const runRow = await tx.execute(sql`
    INSERT INTO orc_runs (team_id, project_id, lane, status, requested_by, pin)
    VALUES (${teamId}, ${input.projectId}, ${input.lane}, 'compiling', ${input.requestedBy}, ${input.pin})
    RETURNING id`);
  const runId = String(runRow.rows[0]?.["id"] ?? "");

  // ---- phase 0b: snapshot. A case from another team simply is not visible under RLS, so
  // buildCompileSnapshot raises CaseNotFoundError ⇒ 404, never 403.
  const env = await loadRunEnvironment(tx, ctx, input.projectId);
  const snapshot = await buildCompileSnapshot(
    tx, ctx,
    { projectId: input.projectId, targetCaseIds: input.targetCaseIds, pin: input.pin },
    { loadElements: deps.loadElements, loadDataProfiles: deps.loadDataProfiles, env },
  );

  // ---- phases 1-7: PURE. No I/O, no clock, no randomness — same input, same content hash.
  const compiled = compileRun({
    snapshot,
    lane: input.lane,
    ...(input.screenshots === undefined ? {} : { screenshots: input.screenshots }),
  });

  if (compiled.plan === undefined) {
    for (const d of compiled.diagnostics) {
      await tx.execute(sql`
        INSERT INTO orc_compile_diagnostics (team_id, run_id, severity, code, case_id, step_ordinal, message)
        VALUES (${teamId}, ${runId}, ${d.severity}, ${d.code}, ${d.caseId}, ${d.stepOrdinal ?? null}, ${d.message})`);
    }
    await tx.execute(sql`
      UPDATE orc_runs SET status = 'finished', verdict = 'compile_error', finished_at = ${input.now}
      WHERE team_id = ${teamId} AND id = ${runId}`);
    // The run never touched the fleet, so the day's budget goes back (blueprint §4 phase 7).
    await refundRunSlot(tx, ctx, { now: input.now });
    return { kind: "compile_error", runId, diagnostics: compiled.diagnostics };
  }

  const plan = compiled.plan;
  await tx.execute(sql`
    INSERT INTO orc_run_plans (team_id, run_id, content_hash, plan_format_version, plan)
    VALUES (${teamId}, ${runId}, ${plan.contentHash}, ${PLAN_FORMAT_VERSION}, ${JSON.stringify(plan)}::jsonb)`);

  // ---- phase 8: dispatch. One row per chain — the chain is the unit of isolation
  // (1 browser context, 1 lease, 1 verdict).
  for (const chain of plan.chains) {
    await tx.execute(sql`
      INSERT INTO job_runs (team_id, run_id, chain_key, lane, job_kind, status, cost)
      VALUES (${teamId}, ${runId}, ${chain.chainKey}, ${input.lane}, 'chain', 'pending', ${jobCost(countSteps(chain))})`);
  }

  await tx.execute(sql`
    UPDATE orc_runs SET status = 'queued', plan_hash = ${plan.contentHash},
      chain_total = ${plan.chains.length}, started_at = ${input.now}
    WHERE team_id = ${teamId} AND id = ${runId}`);

  return { kind: "queued", runId, planHash: plan.contentHash, chainCount: plan.chains.length };
}
```

Nếu `countSteps` của compiler nhận `RunPlan` chứ không nhận một `ChainPlan`, thêm helper cục bộ ngay trong file này (không sửa compiler):

```ts
/** Steps of ONE chain — the compiler exports countSteps for the whole plan. */
function chainStepCount(chain: RunPlan["chains"][number]): number {
  return chain.cases.reduce((n, c) => n + c.steps.length, 0);
}
```

và dùng `jobCost(chainStepCount(chain))`.

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-service.test.ts`
Expected: PASS 6 test.

- [ ] **Step 6: Facade + commit**

```ts
// apps/core/src/modules/orchestration/index.ts — append
export { startRun, jobCost, JOB_COST_MAX, type StartRunInput, type StartRunDeps, type StartRunResult } from "./run-service.js";
// apps/core/src/modules/planning/index.ts — append
export { loadRunEnvironment, EnvironmentNotFoundError } from "./environment.js";
```

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src testkite/apps/core/test/orchestration
git commit -m "M3-ORC T4: phase 0 — snapshot, compileRun, plan bat bien, sinh job_runs; compile_error hoan quota"
```

---

## Task 5 — Claim + lease/epoch: `job-queue.ts`

**Files:**
- Create: `apps/core/src/modules/orchestration/queue/job-queue.ts`
- Create: `apps/core/test/orchestration/job-queue.test.ts`
- Create: `apps/core/test/concurrency/job-claim-race.test.ts` (Postgres THẬT)

**Interfaces:**
- Consumes: `withDispatchRole`, `withTenant` (kernel).
- Produces:
```ts
export const LEASE_SECONDS = 30;
export const MAX_INFRA_ATTEMPTS = 3;
export const OOM_QUARANTINE_THRESHOLD = 2;

export interface ClaimedJobRow {
  readonly jobRunId: string; readonly teamId: string; readonly runId: string;
  readonly chainKey: string; readonly attempt: number; readonly leaseEpoch: number;
  readonly leaseExpiresAt: Date; readonly lane: "interactive" | "batch";
}
export declare function dispatchPending(db: TkDb, opts: { readonly limit: number }): Promise<number>;
export declare function claimJobs(db: TkDb, input: {
  readonly workerId: string; readonly lane: "interactive" | "batch";
  readonly max: number; readonly leaseSeconds?: number;
}): Promise<readonly ClaimedJobRow[]>;

export type EpochOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "stale_epoch"; readonly currentEpoch: number }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "cancelled" }   // run aborted -> 410 JOB_CANCELLED
  | { readonly ok: false; readonly reason: "terminal" };   // already succeeded/failed -> 410 JOB_TERMINAL

export declare function heartbeatJob(tx: TkTx, ctx: TenantContext, input: {
  readonly jobRunId: string; readonly epoch: number; readonly leaseSeconds?: number; readonly now: Date;
}): Promise<EpochOutcome<{ readonly leaseExpiresAt: Date; readonly command: "continue" | "drain" | "cancel" }>>;
export declare function completeJob(tx: TkTx, ctx: TenantContext, input: {
  readonly jobRunId: string; readonly epoch: number;
  readonly verdict: "passed" | "failed" | "aborted_early" | "cancelled";
  readonly infra: { readonly code: string; readonly message: string } | null;
  readonly now: Date;
}): Promise<EpochOutcome<{ readonly requeued: boolean; readonly attempt: number; readonly leaseEpoch: number }>>;
```

- [ ] **Step 1: Viết test ĐỎ (unit, PGlite — ngữ nghĩa epoch, KHÔNG phải tranh chấp)**

```ts
// apps/core/test/orchestration/job-queue.test.ts
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { claimJobs, completeJob, dispatchPending, heartbeatJob } from "../../src/modules/orchestration/queue/job-queue.js";

const now = new Date("2026-08-30T09:00:00Z");

describe("job queue — lease and epoch", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("bumps lease_epoch on claim, so the claimer holds a number nobody else has", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    expect(await dispatchPending(t.db, { limit: 10 })).toBe(1);
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    expect(job?.leaseEpoch).toBe(1);
    expect(job?.attempt).toBe(1);
  });

  it("claims nothing that the dispatcher has not released yet", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 3);                          // still `pending`
    expect(await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 5 })).toEqual([]);
  });

  it("rejects a heartbeat that carries an old epoch (the zombie case)", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.bumpEpoch(job!.teamId, job!.jobRunId);   // reaper took the job away
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: job!.jobRunId, epoch: job!.leaseEpoch, now }));
    expect(res).toMatchObject({ ok: false, reason: "stale_epoch", currentEpoch: job!.leaseEpoch + 1 });
  });

  it("never retries an assertion failure — a verdict is not an error", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => completeJob(tx, ctx, {
      jobRunId: job!.jobRunId, epoch: job!.leaseEpoch, verdict: "failed", infra: null, now }));
    expect(res).toMatchObject({ ok: true, value: { requeued: false, attempt: 1 } });
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status FROM job_runs`));
    expect(String(row.rows[0]?.["status"])).toBe("failed");
  });

  it("requeues an infrastructure error and bumps both attempt and epoch", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => completeJob(tx, ctx, {
      jobRunId: job!.jobRunId, epoch: job!.leaseEpoch, verdict: "failed",
      infra: { code: "browser_oom", message: "chromium killed by cgroup" }, now }));
    expect(res).toMatchObject({ ok: true, value: { requeued: true, attempt: 2, leaseEpoch: 2 } });
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, oom_count FROM job_runs`));
    expect(row.rows[0]).toMatchObject({ status: "pending", oom_count: 1 });
  });

  it("quarantines a chain after 2 OOM instead of feeding it back to the fleet forever", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    let epoch = 0;
    for (let i = 0; i < 2; i += 1) {
      await dispatchPending(t.db, { limit: 1 });
      const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
      epoch = job!.leaseEpoch;
      await t.asTeamCtx(a.teamId, (tx, ctx) => completeJob(tx, ctx, { jobRunId: job!.jobRunId, epoch,
        verdict: "failed", infra: { code: "browser_oom", message: "oom" }, now }));
    }
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, oom_count, quarantined_at FROM job_runs`));
    expect(Number(row.rows[0]?.["oom_count"])).toBe(2);
    expect(row.rows[0]?.["quarantined_at"]).not.toBeNull();
    // Quarantined work is invisible to the dispatcher but still readable by the tenant.
    expect(await dispatchPending(t.db, { limit: 10 })).toBe(0);
  });

  it("gives up after MAX_INFRA_ATTEMPTS instead of looping forever", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    for (let i = 0; i < 3; i += 1) {
      await dispatchPending(t.db, { limit: 1 });
      const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
      await t.asTeamCtx(a.teamId, (tx, ctx) => completeJob(tx, ctx, { jobRunId: job!.jobRunId,
        epoch: job!.leaseEpoch, verdict: "failed", infra: { code: "network", message: "reset" }, now }));
    }
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, attempt, last_error_code FROM job_runs`));
    expect(row.rows[0]).toMatchObject({ status: "failed", attempt: 3, last_error_code: "network" });
  });

  it("answers not_found for a job id that belongs to another team", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.seedJobs(b, 1);
    const foreign = await t.firstJobId(b.teamId);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) =>
      heartbeatJob(tx, ctx, { jobRunId: foreign, epoch: 1, now }));
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/job-queue.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt `job-queue.ts`**

```ts
// apps/core/src/modules/orchestration/queue/job-queue.ts
/**
 * Every statement in this file is written so that CORRECTNESS IS `rowCount`, not a check the
 * caller must remember to perform:
 *   - claim   : `FOR UPDATE SKIP LOCKED` + `UPDATE ... SET lease_epoch = lease_epoch + 1`.
 *               Two workers claiming at the same instant get disjoint sets (measured 2026-08-29:
 *               A=[1,2,3] B=[4,5,6], intersection = [], 8ms while A's tx was still open).
 *   - mutate  : `UPDATE ... WHERE lease_epoch = $epoch`. A zombie writes 0 rows ⇒ 409 STALE_EPOCH.
 *               There is no second mechanism and no "are you still the owner?" round trip.
 *
 * The claim path runs under `withDispatchRole` because the tenant is the ANSWER of the query,
 * not its input. Everything after the claim runs under `withTenant` with the team_id the
 * claim returned, so RLS is back in force for every subsequent statement.
 */
import { sql } from "drizzle-orm";
import { assertTenantContext, withDispatchRole, type TenantContext, type TkDb, type TkTx } from "../../kernel/index.js";

export const LEASE_SECONDS = 30;
export const MAX_INFRA_ATTEMPTS = 3;
export const OOM_QUARANTINE_THRESHOLD = 2;

export interface ClaimedJobRow {
  readonly jobRunId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly chainKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: Date;
  readonly lane: "interactive" | "batch";
}

export type EpochOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "stale_epoch"; readonly currentEpoch: number }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "cancelled" }
  | { readonly ok: false; readonly reason: "terminal" };

const TERMINAL = ["succeeded", "failed", "cancelled", "rejected_quota"] as const;

/**
 * Dispatcher fan-out: pending -> dispatched. Deliberately NOT lane-scoped — the dispatcher
 * looks at the whole queue — which is why its index is (priority DESC, queue_seq) with no
 * leading lane column (measured: 0.205ms vs 10.007ms for the wrong index).
 */
export async function dispatchPending(db: TkDb, opts: { readonly limit: number }): Promise<number> {
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      WITH cand AS (
        SELECT team_id, id FROM job_runs
        WHERE status = 'pending' AND quarantined_at IS NULL
        ORDER BY priority DESC, queue_seq, id
        LIMIT ${opts.limit}
        FOR UPDATE SKIP LOCKED)
      UPDATE job_runs j SET status = 'dispatched'
      FROM cand WHERE j.team_id = cand.team_id AND j.id = cand.id
      RETURNING j.id`);
    return r.rows.length;
  });
}

export async function claimJobs(
  db: TkDb,
  input: {
    readonly workerId: string;
    readonly lane: "interactive" | "batch";
    readonly max: number;
    readonly leaseSeconds?: number;
  },
): Promise<readonly ClaimedJobRow[]> {
  const lease = input.leaseSeconds ?? LEASE_SECONDS;
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      WITH cand AS (
        SELECT team_id, id FROM job_runs
        WHERE status = 'dispatched' AND lane = ${input.lane}
        ORDER BY priority DESC, queue_seq, id
        LIMIT ${input.max}
        FOR UPDATE SKIP LOCKED)
      UPDATE job_runs j
      SET status = 'running',
          lease_epoch = j.lease_epoch + 1,
          worker_id = ${input.workerId},
          lease_expires_at = now() + make_interval(secs => ${lease}),
          heartbeat_at = now(),
          started_at = COALESCE(j.started_at, now())
      FROM cand WHERE j.team_id = cand.team_id AND j.id = cand.id
      RETURNING j.id, j.team_id, j.run_id, j.chain_key, j.attempt, j.lease_epoch, j.lease_expires_at, j.lane`);
    return r.rows.map((row) => ({
      jobRunId: String(row["id"]),
      teamId: String(row["team_id"]),
      runId: String(row["run_id"]),
      chainKey: String(row["chain_key"]),
      attempt: Number(row["attempt"]),
      leaseEpoch: Number(row["lease_epoch"]),
      leaseExpiresAt: new Date(String(row["lease_expires_at"])),
      lane: String(row["lane"]) === "interactive" ? "interactive" : "batch",
    }));
  });
}

/**
 * Tells apart the four ways a mutation can miss, because the worker must react differently to
 * each: not_found = give up quietly, cancelled = the run was aborted, terminal = the job
 * already ended, stale_epoch = you were reaped, drop everything you were doing.
 */
async function classifyMiss(tx: TkTx, teamId: string, jobRunId: string): Promise<EpochOutcome<never>> {
  const r = await tx.execute(sql`
    SELECT lease_epoch, status FROM job_runs WHERE team_id = ${teamId} AND id = ${jobRunId}`);
  const row = r.rows[0];
  if (row === undefined) return { ok: false, reason: "not_found" };
  const status = String(row["status"]);
  if (status === "cancelled") return { ok: false, reason: "cancelled" };
  if ((TERMINAL as readonly string[]).includes(status)) return { ok: false, reason: "terminal" };
  return { ok: false, reason: "stale_epoch", currentEpoch: Number(row["lease_epoch"]) };
}

export async function heartbeatJob(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly jobRunId: string; readonly epoch: number; readonly leaseSeconds?: number; readonly now: Date },
): Promise<EpochOutcome<{ readonly leaseExpiresAt: Date; readonly command: "continue" | "drain" | "cancel" }>> {
  const teamId = assertTenantContext(ctx);
  const lease = input.leaseSeconds ?? LEASE_SECONDS;
  const r = await tx.execute(sql`
    UPDATE job_runs
    SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => ${lease})
    WHERE team_id = ${teamId} AND id = ${input.jobRunId}
      AND lease_epoch = ${input.epoch} AND status = 'running'
    RETURNING lease_expires_at`);
  const row = r.rows[0];
  if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
  return {
    ok: true,
    value: { leaseExpiresAt: new Date(String(row["lease_expires_at"])), command: "continue" },
  };
}

export async function completeJob(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string;
    readonly epoch: number;
    readonly verdict: "passed" | "failed" | "aborted_early" | "cancelled";
    readonly infra: { readonly code: string; readonly message: string } | null;
    readonly now: Date;
  },
): Promise<EpochOutcome<{ readonly requeued: boolean; readonly attempt: number; readonly leaseEpoch: number }>> {
  const teamId = assertTenantContext(ctx);
  const infra = input.infra;

  // AssertionFailure is a VERDICT. Retrying it would poison the result data with a second
  // opinion about a deterministic outcome — blueprint §4, taxonomy of errors.
  if (infra === null) {
    const r = await tx.execute(sql`
      UPDATE job_runs
      SET status = ${input.verdict === "passed" ? "succeeded" : input.verdict === "cancelled" ? "cancelled" : "failed"},
          finished_at = ${input.now}, lease_expires_at = NULL, worker_id = NULL
      WHERE team_id = ${teamId} AND id = ${input.jobRunId} AND lease_epoch = ${input.epoch} AND status = 'running'
      RETURNING attempt, lease_epoch`);
    const row = r.rows[0];
    if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
    return { ok: true, value: { requeued: false, attempt: Number(row["attempt"]), leaseEpoch: Number(row["lease_epoch"]) } };
  }

  const isOom = infra.code === "browser_oom";
  // ONE statement decides everything: requeue at the head of this team's queue, or fail for
  // good, or quarantine. Splitting it into read-then-write would open the exact window the
  // epoch is there to close.
  const r = await tx.execute(sql`
    UPDATE job_runs SET
      oom_count = oom_count + ${isOom ? 1 : 0},
      last_error_code = ${infra.code},
      lease_epoch = lease_epoch + 1,
      worker_id = NULL,
      lease_expires_at = NULL,
      attempt = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN attempt + 1 ELSE attempt END,
      quarantined_at = CASE WHEN ${isOom} AND oom_count + 1 >= ${OOM_QUARANTINE_THRESHOLD}
                            THEN ${input.now} ELSE quarantined_at END,
      status = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
      finished_at = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN NULL ELSE ${input.now} END,
      queue_seq = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS}
        THEN (SELECT COALESCE(MIN(q.queue_seq), job_runs.queue_seq) - 1
              FROM job_runs q WHERE q.team_id = job_runs.team_id AND q.status = 'pending')
        ELSE queue_seq END
    WHERE team_id = ${teamId} AND id = ${input.jobRunId} AND lease_epoch = ${input.epoch} AND status = 'running'
    RETURNING attempt, lease_epoch, status`);
  const row = r.rows[0];
  if (row === undefined) return classifyMiss(tx, teamId, input.jobRunId);
  return {
    ok: true,
    value: {
      requeued: String(row["status"]) === "pending",
      attempt: Number(row["attempt"]),
      leaseEpoch: Number(row["lease_epoch"]),
    },
  };
}
```

- [ ] **Step 4: Chạy test unit, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/job-queue.test.ts`
Expected: PASS 8 test.

- [ ] **Step 5: Viết test tranh chấp THẬT (Postgres, không PGlite)**

```ts
// apps/core/test/concurrency/job-claim-race.test.ts
/**
 * PGlite is a SINGLE wasm connection: two "concurrent" transactions merely queue up, so a
 * SKIP LOCKED test there is theatre. This file runs on a real Postgres and is skipped when
 * TESTKITE_TEST_PG_URL is absent (CI always sets it — postgres:17 is the authoritative engine).
 */
import { beforeAll, expect, it } from "vitest";
import { describeRealPg, makeRealDb, type RealDb } from "../harness/realpg.js";
import { claimJobs, dispatchPending } from "../../src/modules/orchestration/queue/job-queue.js";

describeRealPg("job claim under real contention", () => {
  let r: RealDb;
  beforeAll(async () => { r = await makeRealDb(); });

  it("hands two workers disjoint sets of jobs", async () => {
    const team = await seedTeamWithJobs(r, 8);
    await dispatchPending(r.db, { limit: 8 });
    const [a, b] = await Promise.all([
      claimJobs(r.db, { workerId: "w-A", lane: "batch", max: 4 }),
      claimJobs(r.db, { workerId: "w-B", lane: "batch", max: 4 }),
    ]);
    const ids = new Set([...a, ...b].map((j) => j.jobRunId));
    expect(a.length + b.length).toBe(8);
    expect(ids.size, "a job claimed twice would run twice and bill twice").toBe(8);
    expect([...a, ...b].every((j) => j.leaseEpoch === 1)).toBe(true);
  });

  it("never lets 8 workers over-claim a 3-job queue", async () => {
    await seedTeamWithJobs(r, 3);
    await dispatchPending(r.db, { limit: 3 });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimJobs(r.db, { workerId: `w-${i}`, lane: "batch", max: 2 })),
    );
    expect(claims.flat()).toHaveLength(3);
  });

  it("dispatches each pending job exactly once even with two dispatchers racing", async () => {
    await seedTeamWithJobs(r, 50);
    const [n1, n2] = await Promise.all([
      dispatchPending(r.db, { limit: 50 }),
      dispatchPending(r.db, { limit: 50 }),
    ]);
    expect(n1 + n2).toBe(50);
  });
});
```

`seedTeamWithJobs(r, n)` là helper cục bộ của file test: insert org/team/project/user → `orc_runs` → n hàng `job_runs` `pending` (dùng `r.db.execute(sql…)` với role owner, không cần RLS).

- [ ] **Step 6: Chạy trên Postgres thật, dán output vào PR**

```bash
cd testkite
eval "$(scripts/test-pg.sh start)"
pnpm --filter @testkite/core test test/concurrency/job-claim-race.test.ts
scripts/test-pg.sh stop
```
Expected: PASS 3 test. Không có biến env ⇒ `skipped`, không phải fail.

- [ ] **Step 7: Commit**

```bash
git add testkite/apps/core/src/modules/orchestration/queue testkite/apps/core/test
git commit -m "M3-ORC T5: claim SKIP LOCKED + bump lease_epoch, complete/heartbeat fenced by epoch"
```

---

## Task 6 — Reaper: nghi 15s / chết 30s ⇒ bump epoch + requeue ĐẦU hàng đợi team

**Files:**
- Create: `apps/core/src/modules/orchestration/queue/reaper.ts`
- Create: `apps/core/test/orchestration/reaper.test.ts`
- Create: `apps/core/test/concurrency/lease-epoch-race.test.ts` (Postgres THẬT)

**Interfaces:**
- Produces:
```ts
export const HEARTBEAT_SUSPECT_SECONDS = 15;
export const HEARTBEAT_DEAD_SECONDS = 30;
export interface ReapResult {
  readonly suspect: number;      // >15s without a heartbeat — metric only, not touched
  readonly requeued: number;     // dead and still had attempts left
  readonly failed: number;       // dead and out of attempts
}
export declare function reapDeadLeases(db: TkDb, opts?: { readonly deadSeconds?: number }): Promise<ReapResult>;
```

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/reaper.test.ts
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { reapDeadLeases } from "../../src/modules/orchestration/queue/reaper.js";
import { claimJobs, dispatchPending } from "../../src/modules/orchestration/queue/job-queue.js";

describe("lease reaper", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("leaves a job alone while it is merely suspect (>15s, <30s)", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.ageHeartbeat(job!.jobRunId, 17);
    const res = await reapDeadLeases(t.db);
    expect(res).toMatchObject({ suspect: 1, requeued: 0, failed: 0 });
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, lease_epoch FROM job_runs`));
    expect(row.rows[0]).toMatchObject({ status: "running", lease_epoch: 1 });
  });

  it("requeues a dead job ONCE, bumping attempt and epoch together", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.ageHeartbeat(job!.jobRunId, 31);
    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 1 });
    // Running it again must be a no-op: the job is `pending` now, not `running`.
    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 0 });
    const row = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT status, attempt, lease_epoch, last_error_code FROM job_runs`));
    expect(row.rows[0]).toMatchObject({ status: "pending", attempt: 2, lease_epoch: 2, last_error_code: "lease_expired" });
  });

  it("puts the requeued job at the HEAD of its own team's queue, not the head of everyone's", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.seedJobs(a, 2, ["a1", "a2"]);
    await t.seedJobs(b, 1, ["b1"]);
    await dispatchPending(t.db, { limit: 1 });                 // a1 goes out first (lowest queue_seq)
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.ageHeartbeat(job!.jobRunId, 31);
    await reapDeadLeases(t.db);
    const order = await t.db.execute(sql`
      SELECT chain_key FROM job_runs WHERE status = 'pending' ORDER BY priority DESC, queue_seq, id`);
    expect(order.rows.map((r) => String(r["chain_key"]))).toEqual(["a1", "a2", "b1"]);
  });

  it("makes a zombie's write fail after the reaper took the job", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.ageHeartbeat(job!.jobRunId, 31);
    await reapDeadLeases(t.db);
    const res = await t.asTeamCtx(a.teamId, (tx, ctx) => completeJob(tx, ctx, { jobRunId: job!.jobRunId,
      epoch: job!.leaseEpoch, verdict: "passed", infra: null, now: new Date() }));
    expect(res).toMatchObject({ ok: false, reason: "stale_epoch" });
  });

  it("fails a job for good once the attempts run out", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await t.setAttempt(a.teamId, 3);
    await dispatchPending(t.db, { limit: 1 });
    const [job] = await claimJobs(t.db, { workerId: "w1", lane: "batch", max: 1 });
    await t.ageHeartbeat(job!.jobRunId, 31);
    expect(await reapDeadLeases(t.db)).toMatchObject({ requeued: 0, failed: 1 });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/reaper.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt `reaper.ts`**

```ts
// apps/core/src/modules/orchestration/queue/reaper.ts
/**
 * "Suspect at 15s, dead at 30s" (blueprint §5). Suspect is a METRIC only — a worker that is
 * a little late is still holding a real browser context, and yanking its job would double-run
 * a chain. Dead is an ACTION: bump the epoch (which instantly fences the old owner — measured
 * 2026-08-29: its next write updates 0 rows) and put the chain back at the head of its own
 * team's queue so that team does not lose its place behind everyone else's backlog.
 *
 * Runs ONLY inside the leader's tick. That is not just load-shedding: two reapers racing on
 * the same team both compute MIN(queue_seq)-1 and produce a tie (measured: both -> 0). The
 * order key ends with `id` so even a tie is deterministic, but the single-leader rule is why
 * a tie should never occur in the first place.
 */
import { sql } from "drizzle-orm";
import { withDispatchRole, type TkDb } from "../../kernel/index.js";
import { MAX_INFRA_ATTEMPTS } from "./job-queue.js";

export const HEARTBEAT_SUSPECT_SECONDS = 15;
export const HEARTBEAT_DEAD_SECONDS = 30;

export interface ReapResult {
  readonly suspect: number;
  readonly requeued: number;
  readonly failed: number;
}

export async function reapDeadLeases(
  db: TkDb,
  opts?: { readonly deadSeconds?: number },
): Promise<ReapResult> {
  const dead = opts?.deadSeconds ?? HEARTBEAT_DEAD_SECONDS;
  return withDispatchRole(db, async (tx) => {
    const suspectRow = await tx.execute(sql`
      SELECT count(*)::int n FROM job_runs
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => ${HEARTBEAT_SUSPECT_SECONDS})`);
    const suspect = Number(suspectRow.rows[0]?.["n"] ?? 0);

    const reaped = await tx.execute(sql`
      UPDATE job_runs SET
        lease_epoch = lease_epoch + 1,
        worker_id = NULL,
        lease_expires_at = NULL,
        last_error_code = 'lease_expired',
        attempt = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN attempt + 1 ELSE attempt END,
        status = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
        finished_at = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS} THEN NULL ELSE now() END,
        queue_seq = CASE WHEN attempt < ${MAX_INFRA_ATTEMPTS}
          THEN (SELECT COALESCE(MIN(q.queue_seq), job_runs.queue_seq) - 1
                FROM job_runs q WHERE q.team_id = job_runs.team_id AND q.status = 'pending')
          ELSE queue_seq END
      WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => ${dead})
      RETURNING status`);

    let requeued = 0;
    let failed = 0;
    for (const row of reaped.rows) {
      if (String(row["status"]) === "pending") requeued += 1;
      else failed += 1;
    }
    return { suspect, requeued, failed };
  });
}
```

- [ ] **Step 4: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/reaper.test.ts`
Expected: PASS 5 test.

- [ ] **Step 5: Test kill -9 trên Postgres thật**

```ts
// apps/core/test/concurrency/lease-epoch-race.test.ts
describeRealPg("a worker dies mid-chain", () => {
  it("requeues the chain exactly once and rejects every later write from the zombie", async () => {
    // 1. claim with worker "victim"  2. age its heartbeat past 30s  3. reapDeadLeases
    // 4. worker "rescuer" claims the same chain (epoch 3)
    // 5. the victim tries heartbeat/complete/event with epoch 1 -> every one is stale_epoch
    // 6. exactly ONE row in job_runs, attempt = 2 (not 3), no duplicate chain row
  });
  it("keeps SKIP LOCKED honest while the reaper is running concurrently with a claim", async () => {
    // reapDeadLeases and claimJobs fired together must never hand the same job to both.
  });
});
```
Viết đầy đủ theo cùng cấu trúc helper của Task 5 Step 5 (`seedTeamWithJobs` + `ageHeartbeat` chạy bằng SQL trực tiếp).

- [ ] **Step 6: Chạy + commit**

```bash
cd testkite && eval "$(scripts/test-pg.sh start)" && pnpm --filter @testkite/core test test/concurrency/; scripts/test-pg.sh stop
git add testkite/apps/core/src/modules/orchestration/queue/reaper.ts testkite/apps/core/test
git commit -m "M3-ORC T6: reaper nghi 15s/chet 30s — bump epoch + requeue dau hang doi team"
```

---

## Task 7 — Leader-elect: `orc_dispatcher_lease` (row-lock TTL) + dead-man

Quyết định và số đo nằm ở mục spike §3. Tóm tắt để người implement không phải đọc ngược: **KHÔNG dùng `pg_advisory_lock`** — nó vô hình với alerting, worst case 2h07 khi phân vùng mạng (`tcp_keepalives_idle = 7200`), và rò qua `pg.Pool` (đo được: hai "leader" cùng lúc).

**Files:**
- Create: `apps/core/src/modules/orchestration/db/fleet-schema.ts` (phần `orc_dispatcher_lease`)
- Create: `apps/core/src/modules/orchestration/dispatcher/lease.ts`
- Create: `apps/core/drizzle/NNNN_m3_dispatcher_lease_grants.sql` (viết tay)
- Create: `apps/core/test/orchestration/dispatcher-lease.test.ts`
- Create: `apps/core/test/concurrency/dispatcher-leader.test.ts` (Postgres THẬT)

**Interfaces:**
- Produces:
```ts
export const LEASE_TTL_SECONDS = 10;
export const LEASE_RENEW_EVERY_TICKS = 10;      // tick = 250ms => renew every 2.5s
export interface DispatcherLease {
  readonly holder: string; readonly epoch: number; readonly expiresAt: Date;
}
export declare function acquireOrRenewLease(db: TkDb, input: {
  readonly holder: string; readonly ttlSeconds?: number;
}): Promise<DispatcherLease | null>;                 // null = someone else is leader
export declare function releaseLease(db: TkDb, input: { readonly holder: string; readonly epoch: number }): Promise<void>;
export declare function readLease(db: TkDb): Promise<(DispatcherLease & { readonly lastTickAt: Date | null; readonly stale: boolean }) | null>;
```

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/dispatcher-lease.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { acquireOrRenewLease, readLease, releaseLease } from "../../src/modules/orchestration/dispatcher/lease.js";

describe("dispatcher leader election", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("gives the lease to the first caller and refuses the second", async () => {
    expect(await acquireOrRenewLease(t.db, { holder: "d1" })).toMatchObject({ holder: "d1", epoch: 1 });
    expect(await acquireOrRenewLease(t.db, { holder: "d2" })).toBeNull();
  });

  it("lets the holder renew without changing the epoch — renewing is not a takeover", async () => {
    const first = await acquireOrRenewLease(t.db, { holder: "d1" });
    const again = await acquireOrRenewLease(t.db, { holder: "d1" });
    expect(again?.epoch).toBe(first?.epoch);
  });

  it("hands the lease to a challenger once the TTL expires, with a NEW epoch", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 });
    const taken = await acquireOrRenewLease(t.db, { holder: "d2" });
    expect(taken).toMatchObject({ holder: "d2", epoch: 2 });
  });

  it("fences the old leader: it cannot renew or release after being taken over", async () => {
    const first = await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 });
    await acquireOrRenewLease(t.db, { holder: "d2" });
    expect(await acquireOrRenewLease(t.db, { holder: "d1" })).toBeNull();
    await releaseLease(t.db, { holder: "d1", epoch: first?.epoch ?? 0 });   // no-op, must not free d2's lease
    expect(await acquireOrRenewLease(t.db, { holder: "d3" })).toBeNull();
  });

  it("reports a stale lease so the dead-man alert has something to read", async () => {
    await acquireOrRenewLease(t.db, { holder: "d1", ttlSeconds: 0 });
    const l = await readLease(t.db);
    expect(l).toMatchObject({ holder: "d1", stale: true });
  });

  it("releases cleanly on shutdown so the next dispatcher starts immediately", async () => {
    const l = await acquireOrRenewLease(t.db, { holder: "d1" });
    await releaseLease(t.db, { holder: "d1", epoch: l?.epoch ?? 0 });
    expect(await acquireOrRenewLease(t.db, { holder: "d2" })).toMatchObject({ holder: "d2" });
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/dispatcher-lease.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Schema `orc_dispatcher_lease`**

```ts
// apps/core/src/modules/orchestration/db/fleet-schema.ts  (part 1 of 3 — worker/token tables come in Task 9)
/**
 * `orc_dispatcher_lease` — leadership as a ROW, on purpose.
 *
 * Why not pg_advisory_lock (spike 2026-08-29, numbers in the plan):
 *   - invisible: pg_locks cannot say WHO holds it, since when, or when it last ticked, and
 *     the blueprint's §5 observability list demands a "dispatcher dead-man" alert;
 *   - unbounded worst case: a network-partitioned leader keeps the lock until TCP keepalive
 *     kills the session — the server default here is 7200s idle + 9x75s = ~2h07 with no dispatcher;
 *   - leaks through a connection pool: measured that pg.Pool returned the SAME session and
 *     pg_try_advisory_lock succeeded a second time => two processes both believing they lead.
 * A TTL row costs one UPDATE every 2.5s and fails over in ~TTL (measured 5032ms at TTL=5s).
 *
 * There is exactly ONE row, forever: `id smallint PRIMARY KEY CHECK (id = 1)`.
 * This table is NOT tenant-scoped and has NO RLS — it is fleet infrastructure, and only
 * testkite_dispatch may touch it.
 */
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

export const orcDispatcherLease = pgTable(
  "orc_dispatcher_lease",
  {
    id: smallint("id").primaryKey().default(1),
    holder: text("holder").notNull(),
    /** Bumped ONLY on takeover, never on renew — a stable epoch means "still the same leader". */
    epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("orc_dispatcher_lease_singleton", sql`${t.id} = 1`)],
);
```

- [ ] **Step 4: `lease.ts`**

```ts
// apps/core/src/modules/orchestration/dispatcher/lease.ts
import { sql } from "drizzle-orm";
import { withDispatchRole, type TkDb } from "../../kernel/index.js";

export const LEASE_TTL_SECONDS = 10;
export const LEASE_RENEW_EVERY_TICKS = 10;

export interface DispatcherLease {
  readonly holder: string;
  readonly epoch: number;
  readonly expiresAt: Date;
}

/**
 * Acquire OR renew in one statement. The WHERE clause is the whole election:
 *   holder = me            -> renew (epoch unchanged)
 *   expires_at < now()     -> take over (epoch + 1)
 *   otherwise              -> 0 rows, someone else leads
 */
export async function acquireOrRenewLease(
  db: TkDb,
  input: { readonly holder: string; readonly ttlSeconds?: number },
): Promise<DispatcherLease | null> {
  const ttl = input.ttlSeconds ?? LEASE_TTL_SECONDS;
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO orc_dispatcher_lease (id, holder, epoch, expires_at, last_tick_at)
      VALUES (1, ${input.holder}, 1, now() + make_interval(secs => ${ttl}), now())
      ON CONFLICT (id) DO UPDATE SET
        holder = ${input.holder},
        epoch = CASE WHEN orc_dispatcher_lease.holder = ${input.holder}
                     THEN orc_dispatcher_lease.epoch ELSE orc_dispatcher_lease.epoch + 1 END,
        acquired_at = CASE WHEN orc_dispatcher_lease.holder = ${input.holder}
                           THEN orc_dispatcher_lease.acquired_at ELSE now() END,
        last_tick_at = now(),
        expires_at = now() + make_interval(secs => ${ttl})
      WHERE orc_dispatcher_lease.holder = ${input.holder}
         OR orc_dispatcher_lease.expires_at < now()
      RETURNING holder, epoch, expires_at`);
    const row = r.rows[0];
    if (row === undefined) return null;
    return { holder: String(row["holder"]), epoch: Number(row["epoch"]), expiresAt: new Date(String(row["expires_at"])) };
  });
}

/** Graceful shutdown. Fenced by (holder, epoch) so a leader that was already replaced cannot free its successor's lease. */
export async function releaseLease(db: TkDb, input: { readonly holder: string; readonly epoch: number }): Promise<void> {
  await withDispatchRole(db, (tx) =>
    tx.execute(sql`
      UPDATE orc_dispatcher_lease SET expires_at = now() - interval '1 second'
      WHERE id = 1 AND holder = ${input.holder} AND epoch = ${input.epoch}`),
  );
}

/** What the dead-man alert reads: `stale = true` means nobody has ticked within the TTL. */
export async function readLease(
  db: TkDb,
): Promise<(DispatcherLease & { readonly lastTickAt: Date | null; readonly stale: boolean }) | null> {
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      SELECT holder, epoch, expires_at, last_tick_at, (expires_at < now()) AS stale
      FROM orc_dispatcher_lease WHERE id = 1`);
    const row = r.rows[0];
    if (row === undefined) return null;
    const tick = row["last_tick_at"];
    return {
      holder: String(row["holder"]),
      epoch: Number(row["epoch"]),
      expiresAt: new Date(String(row["expires_at"])),
      lastTickAt: tick === null ? null : new Date(String(tick)),
      stale: row["stale"] === true,
    };
  });
}
```

- [ ] **Step 5: Migration + GRANT**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_dispatcher_lease
```

TAG `m3_dispatcher_lease_grants`:

```sql
-- Fleet infrastructure, not tenant data: no RLS, and the request-path role gets NOTHING.
-- Only the dispatch path may read or write leadership.
GRANT SELECT, INSERT, UPDATE ON orc_dispatcher_lease TO "testkite_dispatch";
```

- [ ] **Step 6: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/dispatcher-lease.test.ts`
Expected: PASS 6 test.

- [ ] **Step 7: Test failover trên Postgres thật (đo thời gian, không đoán)**

```ts
// apps/core/test/concurrency/dispatcher-leader.test.ts
describeRealPg("dispatcher leadership on a real Postgres", () => {
  it("elects exactly one leader out of 5 simultaneous candidates", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => acquireOrRenewLease(r.db, { holder: `d${i}` })),
    );
    expect(results.filter((x) => x !== null)).toHaveLength(1);
  });

  it("promotes a challenger within ~TTL after the leader stops renewing", async () => {
    await acquireOrRenewLease(r.db, { holder: "d1", ttlSeconds: 1 });
    const started = Date.now();
    let won: DispatcherLease | null = null;
    while (won === null && Date.now() - started < 5_000) {
      won = await acquireOrRenewLease(r.db, { holder: "d2", ttlSeconds: 1 });
      if (won === null) await new Promise((res) => setTimeout(res, 250));
    }
    const elapsed = Date.now() - started;
    expect(won).toMatchObject({ holder: "d2", epoch: 2 });
    // TTL 1s + a 250ms poll: comfortably under 2s. The production TTL of 10s measured
    // ~5.03s at TTL=5s in the 2026-08-29 spike, i.e. failover tracks the TTL linearly.
    expect(elapsed).toBeLessThan(2_000);
  });
});
```

- [ ] **Step 8: Commit**

```bash
cd testkite && eval "$(scripts/test-pg.sh start)" && pnpm --filter @testkite/core test test/concurrency/dispatcher-leader.test.ts; scripts/test-pg.sh stop
git add testkite/apps/core/src/modules/orchestration testkite/apps/core/drizzle testkite/apps/core/test
git commit -m "M3-ORC T7: leader-elect bang row-lock TTL (chon thay pg_advisory_lock) + dead-man"
```

---

## Task 8 — Dispatcher v1 FIFO: tick 250ms, fan-out ≤200, chỉ chạy khi giữ lease

**Fair-share DRR là M5 — NGOÀI PHẠM VI plan này** (blueprint §5 mô tả deficit-weighted RR, cost, cap/team, sàn chống đói 60s; M3 chỉ FIFO). `cost` đã có sẵn cột trong `job_runs` để M5 dùng mà không phải migrate lại.

**Files:**
- Create: `apps/core/src/modules/orchestration/dispatcher/loop.ts`
- Create: `apps/core/test/orchestration/dispatcher-loop.test.ts`
- Modify: `apps/core/src/modules/kernel/env.ts` (thêm `DISPATCHER_ENABLED`, `DISPATCHER_ID`)

**Interfaces:**
- Produces:
```ts
export const TICK_MS = 250;
export const FANOUT_PER_TICK = 200;
export interface DispatcherHooks {
  readonly onTick?: (r: TickResult) => void;
  readonly onLeadershipLost?: (holder: string) => void;
  readonly onDeadMan?: (lease: { holder: string; lastTickAt: Date | null }) => void;
}
export interface TickResult {
  readonly leader: boolean; readonly dispatched: number;
  readonly reaped: { readonly suspect: number; readonly requeued: number; readonly failed: number };
}
export declare function runDispatcherTick(db: TkDb, state: DispatcherState, hooks?: DispatcherHooks): Promise<TickResult>;
export declare function startDispatcher(db: TkDb, opts: { readonly holder: string; readonly hooks?: DispatcherHooks }): { readonly stop: () => Promise<void> };
export interface DispatcherState { holder: string; ticks: number; lease: DispatcherLease | null }
```

- [ ] **Step 1: Viết test ĐỎ (tick là hàm thuần-về-thời-gian: gọi tay, không `setInterval` trong test)**

```ts
// apps/core/test/orchestration/dispatcher-loop.test.ts
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { FANOUT_PER_TICK, runDispatcherTick, type DispatcherState } from "../../src/modules/orchestration/dispatcher/loop.js";
import { acquireOrRenewLease } from "../../src/modules/orchestration/dispatcher/lease.js";

const state = (holder: string): DispatcherState => ({ holder, ticks: 0, lease: null });

describe("dispatcher tick", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("dispatches nothing at all when it is not the leader", async () => {
    await acquireOrRenewLease(t.db, { holder: "other" });
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 5);
    const r = await runDispatcherTick(t.db, state("me"));
    expect(r).toMatchObject({ leader: false, dispatched: 0 });
    const pending = await t.db.execute(sql`SELECT count(*)::int n FROM job_runs WHERE status = 'pending'`);
    expect(Number(pending.rows[0]?.["n"])).toBe(5);
  });

  it("caps fan-out at 200 jobs per tick", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 250);
    const r = await runDispatcherTick(t.db, state("me"));
    expect(r.dispatched).toBe(FANOUT_PER_TICK);
    const second = await runDispatcherTick(t.db, state("me"));
    expect(second.dispatched).toBe(50);
  });

  it("dispatches in FIFO order across teams (v1 has no fair share — that is M5)", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.seedJobs(a, 2, ["a1", "a2"]);
    await t.seedJobs(b, 2, ["b1", "b2"]);
    const st = state("me");
    for (let i = 0; i < 3; i += 1) await runDispatcherTickWithLimit(t.db, st, 1);
    const out = await t.db.execute(sql`SELECT chain_key FROM job_runs WHERE status = 'dispatched' ORDER BY queue_seq`);
    expect(out.rows.map((r) => String(r["chain_key"]))).toEqual(["a1", "a2", "b1"]);
  });

  it("reaps dead leases in the same tick that it dispatches", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedJobs(a, 1);
    await t.markRunningWithDeadHeartbeat(a.teamId);
    const r = await runDispatcherTick(t.db, state("me"));
    expect(r.reaped.requeued).toBe(1);
  });

  it("fires the dead-man hook when the lease it reads is stale and held by someone else", async () => {
    await acquireOrRenewLease(t.db, { holder: "ghost", ttlSeconds: 0 });
    const onDeadMan = vi.fn();
    await runDispatcherTick(t.db, state("me"), { onDeadMan });
    // "me" takes over in this very tick, so the alert fires exactly once, on the transition.
    expect(onDeadMan).toHaveBeenCalledWith(expect.objectContaining({ holder: "ghost" }));
  });

  it("reports leadership loss instead of silently dispatching with a dead lease", async () => {
    const st = state("me");
    await runDispatcherTick(t.db, st);                    // "me" is leader
    await t.expireLease();
    await acquireOrRenewLease(t.db, { holder: "rival" });
    const onLeadershipLost = vi.fn();
    const r = await runDispatcherTick(t.db, st, { onLeadershipLost });
    expect(r.leader).toBe(false);
    expect(onLeadershipLost).toHaveBeenCalledWith("me");
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/dispatcher-loop.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Cài đặt `loop.ts`**

```ts
// apps/core/src/modules/orchestration/dispatcher/loop.ts
/**
 * The dispatcher is a LOOP AROUND ONE PURE-ISH FUNCTION. `runDispatcherTick` does one round
 * and returns what happened; `startDispatcher` is the thin timer around it. Tests call the
 * tick directly — a test that waits on setInterval measures the clock, not the code.
 *
 * v1 is strictly FIFO (blueprint §5: "fallback FIFO"). Deficit-weighted round robin, per-team
 * caps and the 60s starvation floor are M5; `job_runs.cost` already carries the number DRR
 * will need, so M5 changes the ORDER BY, not the schema.
 *
 * Correctness does not depend on there being exactly one leader: dispatchPending uses
 * FOR UPDATE SKIP LOCKED and a conditional UPDATE, so two dispatchers in a split-brain window
 * split the work instead of duplicating it (measured 2026-08-29: 50 jobs, two racing
 * dispatchers, 50 total dispatches). Leadership exists to keep the reaper single-threaded
 * and to keep the tick rate predictable.
 */
import { reapDeadLeases } from "../queue/reaper.js";
import { dispatchPending } from "../queue/job-queue.js";
import { acquireOrRenewLease, readLease, releaseLease, LEASE_RENEW_EVERY_TICKS, type DispatcherLease } from "./lease.js";
import type { TkDb } from "../../kernel/index.js";

export const TICK_MS = 250;
export const FANOUT_PER_TICK = 200;

export interface TickResult {
  readonly leader: boolean;
  readonly dispatched: number;
  readonly reaped: { readonly suspect: number; readonly requeued: number; readonly failed: number };
}

export interface DispatcherHooks {
  readonly onTick?: (r: TickResult) => void;
  readonly onLeadershipLost?: (holder: string) => void;
  readonly onDeadMan?: (lease: { readonly holder: string; readonly lastTickAt: Date | null }) => void;
}

export interface DispatcherState {
  holder: string;
  ticks: number;
  lease: DispatcherLease | null;
}

const IDLE: TickResult["reaped"] = { suspect: 0, requeued: 0, failed: 0 };

export async function runDispatcherTick(
  db: TkDb,
  state: DispatcherState,
  hooks?: DispatcherHooks,
  fanout: number = FANOUT_PER_TICK,
): Promise<TickResult> {
  state.ticks += 1;
  const held = state.lease !== null;
  // Renew every 10th tick (2.5s at 250ms) against a 10s TTL: three chances to renew before
  // the lease lapses, so an ordinary GC pause never costs us leadership.
  const mustTouch = !held || state.ticks % LEASE_RENEW_EVERY_TICKS === 0;

  if (mustTouch) {
    const before = held ? null : await readLease(db);
    const lease = await acquireOrRenewLease(db, { holder: state.holder });
    if (lease === null) {
      if (held) hooks?.onLeadershipLost?.(state.holder);
      state.lease = null;
      const result: TickResult = { leader: false, dispatched: 0, reaped: IDLE };
      hooks?.onTick?.(result);
      return result;
    }
    // A stale lease held by SOMEBODY ELSE means that dispatcher died without releasing:
    // the queue was unattended until this moment. That is the dead-man condition.
    if (before !== null && before.stale && before.holder !== state.holder) {
      hooks?.onDeadMan?.({ holder: before.holder, lastTickAt: before.lastTickAt });
    }
    state.lease = lease;
  }

  const reaped = await reapDeadLeases(db);
  const dispatched = await dispatchPending(db, { limit: fanout });
  const result: TickResult = { leader: true, dispatched, reaped };
  hooks?.onTick?.(result);
  return result;
}

export function startDispatcher(
  db: TkDb,
  opts: { readonly holder: string; readonly hooks?: DispatcherHooks },
): { readonly stop: () => Promise<void> } {
  const state: DispatcherState = { holder: opts.holder, ticks: 0, lease: null };
  let running = false;
  let stopped = false;

  // setInterval, NOT a self-scheduling await chain: a tick that runs long must be SKIPPED,
  // not queued behind the previous one — a backlog of ticks would keep dispatching after a
  // stall, all at once, right when the DB is already slow.
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void runDispatcherTick(db, state, opts.hooks)
      .catch(() => undefined)     // a failed tick is a metric, never a crashed process
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (state.lease !== null) await releaseLease(db, { holder: state.holder, epoch: state.lease.epoch });
    },
  };
}
```

`runDispatcherTickWithLimit` trong test = `runDispatcherTick(db, st, undefined, 1)`.

- [ ] **Step 4: Biến env**

Thêm vào `envSchema` trong `apps/core/src/modules/kernel/env.ts` (thêm vào CUỐI object, không chèn giữa):

```ts
  /** false on an API replica that must not run the dispatcher loop (e.g. a read-only pod). */
  DISPATCHER_ENABLED: z.coerce.boolean().default(true),
  /** Identity of this process in the leader election; the hostname is the natural value. */
  DISPATCHER_ID: z.string().min(1).default(hostname()),
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/dispatcher-loop.test.ts`
Expected: PASS 6 test.

- [ ] **Step 6: Commit**

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src testkite/apps/core/test/orchestration/dispatcher-loop.test.ts
git commit -m "M3-ORC T8: dispatcher v1 FIFO — tick 250ms, fan-out 200, reap trong tick, dead-man hook"
```

---

## Task 9 — Worker registry + hai loại token của fleet (zero-credential)

Ba credential (bootstrap → worker token → run token) đúng như hợp đồng ở đầu plan. Cùng kỷ luật lưu trữ với `api_tokens` của M2: DB chỉ giữ SHA-256, prefix rõ để log gọi tên, hạn dùng **bắt buộc**.

**Files:**
- Modify: `apps/core/src/modules/orchestration/db/fleet-schema.ts` (thêm `orc_workers`, `orc_run_tokens`)
- Create: `apps/core/src/modules/orchestration/run-token.ts`
- Create: `apps/core/drizzle/NNNN_m3_run_tokens_grants.sql` (viết tay)
- Create: `apps/core/test/orchestration/run-token.test.ts`

**Interfaces:**
- Produces:
```ts
export const RUN_TOKEN_TTL_SLACK_SECONDS = 60;
export const WORKER_TOKEN_TTL_HOURS = 24;

export interface RunTokenScope {
  readonly tokenId: string; readonly teamId: string; readonly jobRunId: string;
  readonly attempt: number; readonly leaseEpoch: number;
}
export interface WorkerTokenScope {
  readonly workerId: string; readonly lane: "interactive" | "batch"; readonly capacity: number;
}
export declare function registerWorker(db: TkDb, input: {
  readonly workerId: string; readonly hostname: string;
  readonly lane: "interactive" | "batch"; readonly capacity: number; readonly now: Date;
}): Promise<{ readonly workerToken: string; readonly drain: boolean }>;
export declare function verifyWorkerToken(db: TkDb, secret: string, now: Date): Promise<WorkerTokenScope | null>;
export declare function touchWorker(db: TkDb, input: {
  readonly workerId: string; readonly freeSlots: number; readonly now: Date;
}): Promise<{ readonly command: "continue" | "drain" }>;
export declare function mintRunToken(tx: TkTx, ctx: TenantContext, input: {
  readonly jobRunId: string; readonly attempt: number; readonly leaseEpoch: number;
  readonly workerId: string; readonly expiresAt: Date;
}): Promise<{ readonly secret: string; readonly tokenId: string }>;
export declare function verifyRunToken(db: TkDb, secret: string, now: Date): Promise<RunTokenScope | null>;
export declare function revokeRunTokensFor(tx: TkTx, ctx: TenantContext, jobRunId: string): Promise<void>;
```

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/run-token.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import {
  mintRunToken, registerWorker, revokeRunTokensFor, touchWorker, verifyRunToken, verifyWorkerToken,
} from "../../src/modules/orchestration/run-token.js";

const now = new Date("2026-08-30T09:00:00Z");
const later = new Date(now.getTime() + 60_000);

describe("fleet credentials", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("register hands back a worker token scoped to that worker only", async () => {
    const r = await registerWorker(t.db, { workerId: "w1", hostname: "h1", lane: "batch", capacity: 4, now });
    expect(r.workerToken).toMatch(/^tkw_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/);
    expect(await verifyWorkerToken(t.db, r.workerToken, now)).toMatchObject({ workerId: "w1", lane: "batch", capacity: 4 });
  });

  it("register is idempotent: re-registering the same worker rotates the token, never duplicates the row", async () => {
    const first = await registerWorker(t.db, { workerId: "w1", hostname: "h1", lane: "batch", capacity: 4, now });
    const second = await registerWorker(t.db, { workerId: "w1", hostname: "h1", lane: "batch", capacity: 4, now });
    expect(second.workerToken).not.toBe(first.workerToken);
    // The old token dies at once — a restarted worker must not leave a usable credential behind.
    expect(await verifyWorkerToken(t.db, first.workerToken, now)).toBeNull();
    expect(await t.countRows("orc_workers")).toBe(1);
  });

  it("tells a draining worker to stop taking work", async () => {
    await registerWorker(t.db, { workerId: "w1", hostname: "h1", lane: "batch", capacity: 4, now });
    await t.setWorkerDrain("w1", true);
    expect(await touchWorker(t.db, { workerId: "w1", freeSlots: 2, now })).toEqual({ command: "drain" });
  });

  it("run token round-trips the scope it was minted with", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) => mintRunToken(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1, workerId: "w1", expiresAt: later }));
    expect(minted.secret).toMatch(/^tkr_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/);
    expect(await verifyRunToken(t.db, minted.secret, now))
      .toMatchObject({ teamId: a.teamId, jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1 });
  });

  it("stores only a hash — neither secret ever reaches the database in the clear", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) => mintRunToken(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1, workerId: "w1", expiresAt: later }));
    const dump = JSON.stringify(await t.dumpTable("orc_run_tokens"));
    expect(dump).not.toContain(minted.secret.split("_")[2]);
  });

  it("refuses an expired run token", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) => mintRunToken(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1, workerId: "w1",
      expiresAt: new Date(now.getTime() - 1_000) }));
    expect(await verifyRunToken(t.db, minted.secret, now)).toBeNull();
  });

  it("refuses a run token whose job was requeued (revoked on epoch bump)", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) => mintRunToken(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1, workerId: "w1", expiresAt: later }));
    await t.asTeamCtx(a.teamId, (tx, ctx) => revokeRunTokensFor(tx, ctx, job.jobRunId));
    expect(await verifyRunToken(t.db, minted.secret, now)).toBeNull();
  });

  it("carries no team scopes at all — a run token is not a team credential", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const minted = await t.asTeamCtx(a.teamId, (tx, ctx) => mintRunToken(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, leaseEpoch: 1, workerId: "w1", expiresAt: later }));
    const scope = await verifyRunToken(t.db, minted.secret, now);
    // No `scopes`, no `role`, no `userId`. If a future change adds one, this test is the
    // tripwire: the worker would suddenly be able to act as the tenant.
    expect(Object.keys(scope ?? {}).sort()).toEqual(["attempt", "jobRunId", "leaseEpoch", "teamId", "tokenId"]);
  });

  it("rejects a malformed token without touching the database", async () => {
    expect(await verifyRunToken(t.db, "tk_deadbeef_notarunt0ken", now)).toBeNull();
    expect(await verifyWorkerToken(t.db, "tkr_deadbeef_wrongkind", now)).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-token.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Schema (phần 2 của `fleet-schema.ts`)**

```ts
/**
 * `orc_workers` — the fleet roster AND the worker credential. NOT tenant-scoped (a worker
 * serves every tenant in turn), so no RLS: access is by role, exactly like krn_outbox.
 * The token hash lives on the same row so that "delete the worker" and "revoke its
 * credential" cannot drift apart.
 */
export const orcWorkers = pgTable(
  "orc_workers",
  {
    id: text("id").primaryKey(),
    hostname: text("hostname").notNull(),
    lane: text("lane").notNull(),
    capacity: integer("capacity").notNull(),
    drain: boolean("drain").notNull().default(false),
    prefix: text("prefix").notNull(),
    tokenHash: customBytea("token_hash").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    freeSlots: integer("free_slots").notNull().default(0),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orc_workers_hash_uidx").on(t.tokenHash),
    check("orc_workers_lane_check", sql`${t.lane} IN ('interactive','batch')`),
  ],
);

/**
 * `orc_run_tokens` — the ONLY credential a worker ever holds for a tenant's data, and it is
 * not a tenant credential: it names one job, one attempt, one epoch, and it dies with the lease.
 *
 * RLS with a second policy for the AUTH PATH, exactly like api_tokens (M2): verifying a token
 * has to happen BEFORE the tenant is known, so `testkite_auth` gets a SELECT-only
 * `auth_lookup` policy while the request path keeps tenant_isolation.
 */
export const orcRunTokens = pgTable(
  "orc_run_tokens",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    jobRunId: uuid("job_run_id").notNull(),
    attempt: integer("attempt").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    workerId: text("worker_id").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: customBytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_run_tokens_team_id_unique").on(t.teamId, t.id),
    index("orc_run_tokens_team_job_idx").on(t.teamId, t.jobRunId, t.attempt),
    uniqueIndex("orc_run_tokens_hash_uidx").on(t.tokenHash),
    foreignKey({
      name: "orc_run_tokens_job_fk",
      columns: [t.teamId, t.jobRunId],
      foreignColumns: [jobRuns.teamId, jobRuns.id],
    }),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
    pgPolicy("auth_lookup", { as: "permissive", for: "select", to: authRole, using: sql`true` }),
  ],
).enableRLS();
```

`customBytea` = đúng helper `bytea` mà `api_tokens` của M2 đang dùng (import từ `identity/db/schema.ts` nếu đã export; nếu chưa thì khai lại y hệt trong file này — không đổi kiểu cột).

- [ ] **Step 4: `run-token.ts`**

```ts
// apps/core/src/modules/orchestration/run-token.ts
/**
 * ZERO-CREDENTIAL WORKER (blueprint §4, §5). The worker never holds a DB credential and never
 * holds a team API token. It holds two things, both minted here:
 *   - a WORKER token, proving "I am worker w-1 on lane batch" — enough to register and claim;
 *   - a RUN token, naming exactly one (job_run, attempt, lease_epoch), expiring with the lease.
 *
 * SHA-256 rather than argon2 — same reasoning as api_tokens (M2): 32 bytes of machine entropy
 * has nothing to brute force, and this is verified on every heartbeat (every 5s per running chain).
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  assertTenantContext, withAuthRole, withDispatchRole,
  type TenantContext, type TkDb, type TkTx,
} from "../kernel/index.js";

export const RUN_TOKEN_TTL_SLACK_SECONDS = 60;
export const WORKER_TOKEN_TTL_HOURS = 24;

const RUN_RE = /^tkr_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;
const WORKER_RE = /^tkw_([0-9a-f]{8})_([A-Za-z0-9_-]{20,})$/;

function mintSecret(kind: "tkr" | "tkw"): { secret: string; prefix: string; hash: Buffer } {
  const prefix = randomBytes(4).toString("hex");
  const secret = `${kind}_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix, hash: createHash("sha256").update(secret).digest() };
}

export interface RunTokenScope {
  readonly tokenId: string;
  readonly teamId: string;
  readonly jobRunId: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
}

export interface WorkerTokenScope {
  readonly workerId: string;
  readonly lane: "interactive" | "batch";
  readonly capacity: number;
}

/**
 * Registration ROTATES the credential: a worker that restarts (systemd Restart=always) gets a
 * fresh token and the previous one stops working the same instant. Leaving the old one alive
 * would mean a crashed container's credential outlives the container.
 */
export async function registerWorker(
  db: TkDb,
  input: {
    readonly workerId: string; readonly hostname: string;
    readonly lane: "interactive" | "batch"; readonly capacity: number; readonly now: Date;
  },
): Promise<{ readonly workerToken: string; readonly drain: boolean }> {
  const { secret, prefix, hash } = mintSecret("tkw");
  const expiresAt = new Date(input.now.getTime() + WORKER_TOKEN_TTL_HOURS * 3_600_000);
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      INSERT INTO orc_workers (id, hostname, lane, capacity, prefix, token_hash, token_expires_at)
      VALUES (${input.workerId}, ${input.hostname}, ${input.lane}, ${input.capacity}, ${prefix}, ${hash}, ${expiresAt})
      ON CONFLICT (id) DO UPDATE SET
        hostname = EXCLUDED.hostname, lane = EXCLUDED.lane, capacity = EXCLUDED.capacity,
        prefix = EXCLUDED.prefix, token_hash = EXCLUDED.token_hash,
        token_expires_at = EXCLUDED.token_expires_at, last_seen_at = now()
      RETURNING drain`);
    return { workerToken: secret, drain: r.rows[0]?.["drain"] === true };
  });
}

export async function verifyWorkerToken(db: TkDb, secret: string, now: Date): Promise<WorkerTokenScope | null> {
  if (!WORKER_RE.test(secret)) return null;           // malformed or the wrong KIND of token
  const hash = createHash("sha256").update(secret).digest();
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      SELECT id, lane, capacity FROM orc_workers
      WHERE token_hash = ${hash} AND token_expires_at > ${now}`);
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      workerId: String(row["id"]),
      lane: String(row["lane"]) === "interactive" ? "interactive" : "batch",
      capacity: Number(row["capacity"]),
    };
  });
}

/** The worker heartbeat: records liveness/free slots and answers with the only command the host obeys. */
export async function touchWorker(
  db: TkDb,
  input: { readonly workerId: string; readonly freeSlots: number; readonly now: Date },
): Promise<{ readonly command: "continue" | "drain" }> {
  return withDispatchRole(db, async (tx) => {
    const r = await tx.execute(sql`
      UPDATE orc_workers SET last_seen_at = ${input.now}, free_slots = ${input.freeSlots}
      WHERE id = ${input.workerId} RETURNING drain`);
    return { command: r.rows[0]?.["drain"] === true ? "drain" : "continue" };
  });
}

export async function mintRunToken(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly jobRunId: string; readonly attempt: number; readonly leaseEpoch: number;
    readonly workerId: string; readonly expiresAt: Date;
  },
): Promise<{ readonly secret: string; readonly tokenId: string }> {
  const teamId = assertTenantContext(ctx);
  const { secret, prefix, hash } = mintSecret("tkr");
  const r = await tx.execute(sql`
    INSERT INTO orc_run_tokens (team_id, job_run_id, attempt, lease_epoch, worker_id, prefix, token_hash, expires_at)
    VALUES (${teamId}, ${input.jobRunId}, ${input.attempt}, ${input.leaseEpoch}, ${input.workerId},
            ${prefix}, ${hash}, ${input.expiresAt})
    RETURNING id`);
  return { secret, tokenId: String(r.rows[0]?.["id"]) };
}

/**
 * Verification runs on the AUTH PATH: the tenant is unknown until the row is found, which is
 * the same fail-closed deadlock api_tokens hit in M2 and is solved the same way —
 * `withAuthRole` + an `auth_lookup` policy. This function RETURNS the tenant; it never takes one.
 */
export async function verifyRunToken(db: TkDb, secret: string, now: Date): Promise<RunTokenScope | null> {
  if (!RUN_RE.test(secret)) return null;              // malformed or the wrong KIND: no DB round trip
  const hash = createHash("sha256").update(secret).digest();
  return withAuthRole(db, async (tx) => {
    const r = await tx.execute(sql`
      SELECT id, team_id, job_run_id, attempt, lease_epoch FROM orc_run_tokens
      WHERE token_hash = ${hash} AND revoked_at IS NULL AND expires_at > ${now}`);
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      tokenId: String(row["id"]),
      teamId: String(row["team_id"]),
      jobRunId: String(row["job_run_id"]),
      attempt: Number(row["attempt"]),
      leaseEpoch: Number(row["lease_epoch"]),
    };
  });
}

/** Called whenever ownership of a job changes (reap, cancel, complete): the token dies with the lease. */
export async function revokeRunTokensFor(tx: TkTx, ctx: TenantContext, jobRunId: string): Promise<void> {
  const teamId = assertTenantContext(ctx);
  await tx.execute(sql`
    UPDATE orc_run_tokens SET revoked_at = now()
    WHERE team_id = ${teamId} AND job_run_id = ${jobRunId} AND revoked_at IS NULL`);
}
```

- [ ] **Step 5: Migration + GRANT**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_run_tokens
```

TAG `m3_run_tokens_grants`:

```sql
-- The auth path must read a run token BEFORE the tenant is known (same deadlock as
-- api_tokens in M2, migration 0016). SELECT only, through the auth_lookup policy.
GRANT SELECT ON orc_run_tokens TO "testkite_auth";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON orc_run_tokens TO "testkite_app";
--> statement-breakpoint
-- The fleet roster is not tenant data and carries the worker credential; only the dispatch
-- path touches it. The request-path role gets NOTHING here.
GRANT SELECT, INSERT, UPDATE ON orc_workers TO "testkite_dispatch";
```

- [ ] **Step 6: Chạy test XANH + commit**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/run-token.test.ts`
Expected: PASS 9 test.

```bash
git add testkite/apps/core/src/modules/orchestration testkite/apps/core/drizzle testkite/apps/core/test
git commit -m "M3-ORC T9: orc_workers + worker token xoay khi register + run token scope (job, attempt, epoch)"
```

---

## Task 10 — `orc_run_events`: sự kiện từ worker, idempotent theo `seq`

**Files:**
- Modify: `apps/core/src/modules/orchestration/db/fleet-schema.ts` (thêm `orcRunEvents`)
- Create: `apps/core/src/modules/orchestration/events.ts`
- Create: `apps/core/drizzle/NNNN_m3_run_events_grants.sql` (viết tay)
- Create: `apps/core/test/orchestration/events.test.ts`

**Interfaces:**
- Produces:
```ts
export const RUN_EVENT_KINDS = ["chain_started", "case_started", "case_finished",
  "step_started", "step_finished", "screenshot", "infra_error"] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];
export interface RecordEventInput {
  readonly jobRunId: string; readonly attempt: number; readonly seq: number;
  readonly kind: RunEventKind; readonly payload: Readonly<Record<string, unknown>>;
}
export declare function recordRunEvent(tx: TkTx, ctx: TenantContext, input: RecordEventInput): Promise<{ readonly accepted: boolean; readonly duplicate: boolean }>;
export declare function readRunEvents(tx: TkTx, ctx: TenantContext, input: {
  readonly runId: string; readonly afterSeqByJob?: ReadonlyMap<string, number>;
}): Promise<readonly StoredRunEvent[]>;
export interface StoredRunEvent {
  readonly jobRunId: string; readonly attempt: number; readonly seq: number;
  readonly kind: RunEventKind; readonly payload: Readonly<Record<string, unknown>>; readonly receivedAt: Date;
}
```

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/events.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";
import { readRunEvents, recordRunEvent } from "../../src/modules/orchestration/events.js";

describe("run events", () => {
  let t: TestDb;
  beforeEach(async () => { t = await makeTestDb(); });

  it("accepts a new seq and reports a replay as a duplicate, not an error", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    const ev = { jobRunId: job.jobRunId, attempt: 1, seq: 1, kind: "step_started" as const, payload: { ordinal: 1 } };
    expect(await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, ev)))
      .toEqual({ accepted: true, duplicate: false });
    // A worker retrying after a network blip must not be punished — and must not double-write.
    expect(await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, ev)))
      .toEqual({ accepted: true, duplicate: true });
  });

  it("keeps the FIRST write for a seq — a later, different payload cannot rewrite history", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, seq: 1, kind: "step_finished", payload: { verdict: "passed" } }));
    await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, seq: 1, kind: "step_finished", payload: { verdict: "failed" } }));
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) => readRunEvents(tx, ctx, { runId: job.runId }));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ verdict: "passed" });
  });

  it("accepts events out of order and reports them back in seq order", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    for (const seq of [3, 1, 2]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId, attempt: 1, seq, kind: "step_started", payload: {} }));
    }
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) => readRunEvents(tx, ctx, { runId: job.runId }));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps attempt 2's events separate from attempt 1's — the same seq means a different event", async () => {
    const [a] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    for (const attempt of [1, 2]) {
      await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, {
        jobRunId: job.jobRunId, attempt, seq: 1, kind: "chain_started", payload: { attempt } }));
    }
    const events = await t.asTeamCtx(a.teamId, (tx, ctx) => readRunEvents(tx, ctx, { runId: job.runId }));
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it("never returns another team's events", async () => {
    const [a, b] = await t.seedTwoTeams();
    const job = await t.seedClaimedJob(a);
    await t.asTeamCtx(a.teamId, (tx, ctx) => recordRunEvent(tx, ctx, {
      jobRunId: job.jobRunId, attempt: 1, seq: 1, kind: "chain_started", payload: {} }));
    const seen = await t.asTeamCtx(b.teamId, (tx, ctx) => readRunEvents(tx, ctx, { runId: job.runId }));
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/events.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Schema (phần 3 của `fleet-schema.ts`) + `events.ts`**

```ts
/**
 * `orc_run_events` — the worker's narration of a chain. Idempotency is a UNIQUE constraint,
 * not application logic: (team_id, job_run_id, attempt, seq) + ON CONFLICT DO NOTHING.
 * Measured 2026-08-29: a replayed seq inserts 0 rows, and a replay carrying a DIFFERENT payload
 * also inserts 0 rows — the first write wins, so a confused (or malicious) worker cannot
 * rewrite what already happened.
 *
 * `attempt` is part of the key because attempt 2 legitimately starts its narration at seq 1
 * again; without it, the retry would look like a pile of duplicates and vanish.
 */
export const orcRunEvents = pgTable(
  "orc_run_events",
  {
    teamId: uuid("team_id").notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    jobRunId: uuid("job_run_id").notNull(),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("orc_run_events_team_id_unique").on(t.teamId, t.id),
    unique("orc_run_events_seq_unique").on(t.teamId, t.jobRunId, t.attempt, t.seq),
    index("orc_run_events_team_job_idx").on(t.teamId, t.jobRunId, t.attempt, t.seq),
    foreignKey({
      name: "orc_run_events_job_fk",
      columns: [t.teamId, t.jobRunId],
      foreignColumns: [jobRuns.teamId, jobRuns.id],
    }),
    check("orc_run_events_seq_check", sql`${t.seq} >= 1`),
    pgPolicy("tenant_isolation", {
      as: "permissive", for: "all", to: appRole,
      using: tenantPredicate, withCheck: tenantPredicate,
    }),
  ],
).enableRLS();
```

```ts
// apps/core/src/modules/orchestration/events.ts
import { sql } from "drizzle-orm";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";

export const RUN_EVENT_KINDS = [
  "chain_started", "case_started", "case_finished",
  "step_started", "step_finished", "screenshot", "infra_error",
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export interface RecordEventInput {
  readonly jobRunId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StoredRunEvent {
  readonly jobRunId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly kind: RunEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: Date;
}

export async function recordRunEvent(
  tx: TkTx,
  ctx: TenantContext,
  input: RecordEventInput,
): Promise<{ readonly accepted: boolean; readonly duplicate: boolean }> {
  const teamId = assertTenantContext(ctx);
  const r = await tx.execute(sql`
    INSERT INTO orc_run_events (team_id, job_run_id, attempt, seq, kind, payload)
    VALUES (${teamId}, ${input.jobRunId}, ${input.attempt}, ${input.seq}, ${input.kind},
            ${JSON.stringify(input.payload)}::jsonb)
    ON CONFLICT ON CONSTRAINT orc_run_events_seq_unique DO NOTHING
    RETURNING id`);
  // A duplicate is a SUCCESS for the caller: at-least-once delivery means retries are normal
  // traffic, and answering 409 would make a healthy worker look broken.
  return { accepted: true, duplicate: r.rows.length === 0 };
}

export async function readRunEvents(
  tx: TkTx,
  ctx: TenantContext,
  input: { readonly runId: string; readonly afterSeqByJob?: ReadonlyMap<string, number> },
): Promise<readonly StoredRunEvent[]> {
  assertTenantContext(ctx);
  const r = await tx.execute(sql`
    SELECT e.job_run_id, e.attempt, e.seq, e.kind, e.payload, e.received_at
    FROM orc_run_events e
    JOIN job_runs j ON j.team_id = e.team_id AND j.id = e.job_run_id
    WHERE j.run_id = ${input.runId}
    ORDER BY e.attempt, e.seq, e.job_run_id`);
  const after = input.afterSeqByJob;
  return r.rows
    .map((row) => ({
      jobRunId: String(row["job_run_id"]),
      attempt: Number(row["attempt"]),
      seq: Number(row["seq"]),
      kind: String(row["kind"]) as RunEventKind,
      payload: (row["payload"] ?? {}) as Readonly<Record<string, unknown>>,
      receivedAt: new Date(String(row["received_at"])),
    }))
    .filter((e) => after === undefined || e.seq > (after.get(e.jobRunId) ?? 0));
}
```

- [ ] **Step 4: Migration + GRANT**

```bash
cd testkite/apps/core && pnpm db:generate --name=m3_run_events
```

TAG `m3_run_events_grants`:

```sql
-- APPEND-ONLY at the privilege layer: the worker's narration is evidence. No UPDATE, no DELETE.
GRANT SELECT, INSERT ON orc_run_events TO "testkite_app";
```

- [ ] **Step 5: Chạy test XANH + commit**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/events.test.ts`
Expected: PASS 5 test.

```bash
git add testkite/apps/core/src/modules/orchestration testkite/apps/core/drizzle testkite/apps/core/test
git commit -m "M3-ORC T10: orc_run_events idempotent theo (job, attempt, seq), append-only"
```

---

## Task 11 — Results 3 tầng: `res_case_results` / `res_step_results` partition tháng + luật đọc `MAX(attempt)`

Ba luật đã **đo lại bằng lệnh thật** (spike §7), không chép niềm tin từ M2: key duy nhất phải chứa partition key; **GRANT chỉ trên bảng cha**; có default partition ⇒ không `DETACH CONCURRENTLY`.

**Files:**
- Create: `apps/core/src/modules/results/db/schema.ts` (kiểu drizzle, **không** sinh DDL)
- Create: `apps/core/drizzle/NNNN_m3_res_results.sql` (VIẾT TAY — drizzle-kit không sinh `PARTITION BY`)
- Create: `apps/core/src/modules/results/results-service.ts`
- Create: `apps/core/test/results/partition.test.ts`, `apps/core/test/results/read-rule.test.ts`
- Modify: `apps/core/src/modules/results/index.ts`, `apps/core/drizzle.config.ts` (không cần đổi — file đặt tên `schema.ts` sẽ bị glob bắt, nên **đổi tên thành `results-schema.ts`** đúng như `audit-schema.ts` của M2)

**Interfaces:**
- Produces:
```ts
export const RESULT_RETENTION_DAYS = 400;
export declare function ensureResultPartitionsSql(months: number): string;
export interface CaseResultInput {
  readonly caseId: string; readonly chainKey: string;
  readonly verdict: "passed" | "failed" | "skipped" | "blocked";
  readonly startedAt: Date; readonly finishedAt: Date;
  readonly steps: readonly StepResultInput[];
}
export interface StepResultInput {
  readonly ordinal: number; readonly verdict: "passed" | "failed" | "skipped";
  readonly renderedSentence: string; readonly durationMs: number;
  readonly failureContext: Readonly<Record<string, unknown>> | null;
  readonly screenshotArtifactId: string | null;
  readonly thumbhash: string | null;
}
export declare function writeCaseResults(tx: TkTx, ctx: TenantContext, input: {
  readonly runId: string; readonly jobRunId: string; readonly attempt: number;
  readonly cases: readonly CaseResultInput[];
}): Promise<void>;
export declare function latestCaseResults(tx: TkTx, ctx: TenantContext, runId: string): Promise<readonly CaseResultRow[]>;
export declare function latestStepResults(tx: TkTx, ctx: TenantContext, caseResultId: string): Promise<readonly StepResultRow[]>;
```

- [ ] **Step 1: Viết test ĐỎ cho partition + quyền**

```ts
// apps/core/test/results/partition.test.ts
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../harness/pglite.js";

describe("res_* monthly partitions", () => {
  let t: TestDb;
  beforeAll(async () => { t = await makeTestDb(); });

  it("partitions both result tables by month", async () => {
    const r = await t.db.execute(sql`
      SELECT c.relname, p.partstrat FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid WHERE c.relname LIKE 'res_%'`);
    expect(r.rows.map((x) => String(x["relname"])).sort()).toEqual(["res_case_results", "res_step_results"]);
  });

  it("includes the partition key in every unique constraint (Postgres refuses otherwise)", async () => {
    // Spike 2026-08-29: PRIMARY KEY (team_id, id) on a table partitioned by started_at fails
    // with 0A000 "unique constraint on partitioned table must include all partitioning columns".
    const r = await t.db.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
      WHERE conrelid IN ('res_case_results'::regclass, 'res_step_results'::regclass) AND contype IN ('p','u')`);
    for (const row of r.rows) expect(String(row["def"])).toContain("started_at");
  });

  it("grants nothing on a child partition — a child has relrowsecurity = false", async () => {
    // Measured: after GRANT SELECT on the child, a team-A session read all 3 rows including team B's.
    const r = await t.db.execute(sql`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee IN ('testkite_app','testkite_auth','testkite_dispatch')
        AND table_name ~ '^res_(case|step)_results_'`);
    expect(r.rows, "GRANT belongs on the parent only").toEqual([]);
  });

  it("routes a row into the month partition matching started_at", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedCaseResult(a, new Date("2026-08-15T00:00:00Z"));
    const r = await t.db.execute(sql`SELECT tableoid::regclass::text t FROM res_case_results`);
    expect(String(r.rows[0]?.["t"])).toBe("res_case_results_2026_08");
  });

  it("keeps an out-of-range row instead of rejecting it (default partition)", async () => {
    const [a] = await t.seedTwoTeams();
    await t.seedCaseResult(a, new Date("2019-01-01T00:00:00Z"));
    const r = await t.db.execute(sql`SELECT count(*)::int n FROM res_case_results_default`);
    expect(Number(r.rows[0]?.["n"])).toBe(1);
  });

  it("hides another team's results behind RLS on the parent", async () => {
    const [a, b] = await t.seedTwoTeams();
    await t.seedCaseResult(a, new Date("2026-08-15T00:00:00Z"));
    const seen = await t.asTeam(b.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM res_case_results`));
    expect(Number(seen.rows[0]?.["n"])).toBe(0);
  });
});
```

```ts
// apps/core/test/results/read-rule.test.ts
describe("MAX(attempt) read rule", () => {
  it("returns only the newest attempt for each case, and keeps the older row on disk", async () => {
    // attempt 1 = failed(browser_oom), attempt 2 = passed
    const rows = await t.asTeamCtx(a.teamId, (tx, ctx) => latestCaseResults(tx, ctx, runId));
    expect(rows.map((r) => ({ attempt: r.attempt, verdict: r.verdict }))).toEqual([{ attempt: 2, verdict: "passed" }]);
    const all = await t.asTeam(a.teamId, (tx) => tx.execute(sql`SELECT count(*)::int n FROM res_case_results`));
    expect(Number(all.rows[0]?.["n"]), "attempt 1 is evidence, kept 7 days").toBe(2);
  });

  it("reads steps of the newest attempt only", async () => { /* same shape, on res_step_results */ });

  it("does not mix two chains of the same run", async () => { /* two chain_keys, each with its own MAX(attempt) */ });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/results/`
Expected: FAIL — `relation "res_case_results" does not exist`.

- [ ] **Step 3: Migration VIẾT TAY (TAG `m3_res_results`)**

```sql
-- res_case_results / res_step_results: partitioned BY MONTH, kept 400 days (blueprint §2, §5).
-- HANDWRITTEN SQL because drizzle-kit 0.31 cannot emit PARTITION BY. Both tables sit OUTSIDE
-- drizzle.config.ts's schema glob on purpose (see results/db/results-schema.ts) — exactly the
-- arrangement audit_events uses in M2.
--
-- Evidence from the 2026-08-29 spike, re-run against THIS schema rather than copied from M2:
--  * a unique key must contain the partition key => PRIMARY KEY (team_id, id, started_at).
--    Leaving it out fails with 0A000.
--  * a composite FK FROM a partitioned table INTO a partitioned table WORKS, provided it carries
--    the parent's partition key => res_step_results must keep case_result_started_at.
--  * GRANT ON THE PARENT ONLY. Reproduced: GRANT SELECT on a child partition let a team-A
--    session read all 3 rows of both teams (a child has relrowsecurity = false).
--  * with a DEFAULT partition present, DETACH ... CONCURRENTLY fails with 55000, so retention
--    uses a plain DETACH inside a maintenance window.
CREATE TYPE "public"."result_verdict" AS ENUM('passed', 'failed', 'skipped', 'blocked');
--> statement-breakpoint
CREATE TABLE "res_case_results" (
  "team_id" uuid NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "run_id" uuid NOT NULL,
  "job_run_id" uuid NOT NULL,
  "case_id" uuid NOT NULL,
  "chain_key" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "verdict" "result_verdict" NOT NULL,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "finished_at" timestamp with time zone,
  CONSTRAINT "res_case_results_pkey" PRIMARY KEY ("team_id", "id", "started_at"),
  CONSTRAINT "res_case_results_attempt_unique" UNIQUE ("team_id", "job_run_id", "case_id", "attempt", "started_at"),
  CONSTRAINT "res_case_results_job_fk" FOREIGN KEY ("team_id", "job_run_id")
    REFERENCES "public"."job_runs" ("team_id", "id")
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
CREATE INDEX "res_case_results_team_run_idx" ON "res_case_results" ("team_id", "run_id", "attempt" DESC);
--> statement-breakpoint
CREATE TABLE "res_step_results" (
  "team_id" uuid NOT NULL,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "case_result_id" uuid NOT NULL,
  -- Carries the parent's partition key: a FK into a partitioned table must reference its
  -- full unique key, and that key is required to include started_at.
  "case_result_started_at" timestamp with time zone NOT NULL,
  "step_ordinal" integer NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "verdict" "result_verdict" NOT NULL,
  "rendered_sentence" text NOT NULL,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "failure_context" jsonb,
  "screenshot_artifact_id" uuid,
  -- ~30 bytes: the gallery paints every placeholder instantly and lazy-loads the real
  -- image on scroll (blueprint §5.2 deep-compression tier 1).
  "thumbhash" text,
  CONSTRAINT "res_step_results_pkey" PRIMARY KEY ("team_id", "id", "started_at"),
  CONSTRAINT "res_step_results_case_fk" FOREIGN KEY ("team_id", "case_result_id", "case_result_started_at")
    REFERENCES "public"."res_case_results" ("team_id", "id", "started_at")
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
CREATE INDEX "res_step_results_team_case_idx" ON "res_step_results" ("team_id", "case_result_id", "step_ordinal");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_result_partition(p_table text, p_month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  start_ts timestamptz := date_trunc('month', p_month::timestamptz);
  end_ts   timestamptz := date_trunc('month', p_month::timestamptz) + interval '1 month';
  part     text := p_table || '_' || to_char(start_ts, 'YYYY_MM');
BEGIN
  IF to_regclass('public.' || part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, p_table, start_ts, end_ts);
    RETURN 'created ' || part;
  END IF;
  RETURN 'exists ' || part;
END $$;
--> statement-breakpoint
DO $$
DECLARE i int; tname text;
BEGIN
  FOREACH tname IN ARRAY ARRAY['res_case_results','res_step_results'] LOOP
    FOR i IN 0..13 LOOP
      PERFORM ensure_result_partition(tname, (date_trunc('month', now()) + (i || ' months')::interval)::date);
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE "res_case_results_default" PARTITION OF "res_case_results" DEFAULT;
--> statement-breakpoint
CREATE TABLE "res_step_results_default" PARTITION OF "res_step_results" DEFAULT;
--> statement-breakpoint
ALTER TABLE "res_case_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "res_step_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "res_case_results" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "res_step_results" AS PERMISSIVE FOR ALL TO "testkite_app"
  USING (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid)
  WITH CHECK (team_id = NULLIF(current_setting('app.team_id', true), '')::uuid);
--> statement-breakpoint
-- APPEND-ONLY. A result is evidence: a later attempt adds a ROW, it never edits the old one.
-- GRANT ON THE PARENT ONLY — never on a partition (see the header).
GRANT SELECT, INSERT ON "res_case_results" TO "testkite_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON "res_step_results" TO "testkite_app";
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION ensure_result_partition(text, date) FROM PUBLIC;
```

Thêm entry `_journal.json` với tag `m3_res_results`.

- [ ] **Step 4: Kiểu drizzle (KHÔNG sinh DDL) + service**

```ts
// apps/core/src/modules/results/db/results-schema.ts
/**
 * Drizzle types for the partitioned result tables. DDL is NOT generated from this file —
 * it is named `results-schema.ts`, not `schema.ts`, so drizzle.config.ts's glob
 * (`./src/modules/<module>/db/schema.ts`) cannot reach it. Same trick, same reason, as
 * governance/db/audit-schema.ts in M2: drizzle-kit would emit a flat CREATE TABLE and
 * silently undo the partitioning.
 * `test/results/partition.test.ts` compares the columns on both sides so they cannot drift.
 */
```

```ts
// apps/core/src/modules/results/results-service.ts
/**
 * THE READ RULE: a run's result is the row with the HIGHEST attempt (blueprint §5).
 * Older attempts stay for 7 days as evidence — an infra retry that flips a verdict is
 * exactly the thing an SRE needs to see afterwards — but no product surface ever shows
 * two verdicts for one case.
 *
 * DISTINCT ON is the Postgres-native way to write it and reads as the rule itself:
 * "one row per case, ordered by attempt descending, take the first".
 */
import { sql } from "drizzle-orm";
import { assertTenantContext, type TenantContext, type TkTx } from "../kernel/index.js";

export const RESULT_RETENTION_DAYS = 400;

export async function latestCaseResults(
  tx: TkTx,
  ctx: TenantContext,
  runId: string,
): Promise<readonly CaseResultRow[]> {
  assertTenantContext(ctx);
  const r = await tx.execute(sql`
    SELECT DISTINCT ON (job_run_id, case_id) id, started_at, job_run_id, case_id, chain_key,
           attempt, verdict, duration_ms, finished_at
    FROM res_case_results
    WHERE run_id = ${runId}
    ORDER BY job_run_id, case_id, attempt DESC`);
  return r.rows.map(toCaseResultRow);
}

export async function writeCaseResults(
  tx: TkTx,
  ctx: TenantContext,
  input: {
    readonly runId: string; readonly jobRunId: string; readonly attempt: number;
    readonly cases: readonly CaseResultInput[];
  },
): Promise<void> {
  const teamId = assertTenantContext(ctx);
  for (const c of input.cases) {
    const caseRow = await tx.execute(sql`
      INSERT INTO res_case_results (team_id, run_id, job_run_id, case_id, chain_key, attempt,
                                    verdict, duration_ms, started_at, finished_at)
      VALUES (${teamId}, ${input.runId}, ${input.jobRunId}, ${c.caseId}, ${c.chainKey}, ${input.attempt},
              ${c.verdict}, ${c.finishedAt.getTime() - c.startedAt.getTime()}, ${c.startedAt}, ${c.finishedAt})
      RETURNING id, started_at`);
    const caseId = String(caseRow.rows[0]?.["id"]);
    const caseStartedAt = String(caseRow.rows[0]?.["started_at"]);
    for (const s of c.steps) {
      await tx.execute(sql`
        INSERT INTO res_step_results (team_id, case_result_id, case_result_started_at, step_ordinal,
          attempt, verdict, rendered_sentence, duration_ms, failure_context, screenshot_artifact_id,
          thumbhash, started_at)
        VALUES (${teamId}, ${caseId}, ${caseStartedAt}, ${s.ordinal}, ${input.attempt}, ${s.verdict},
          ${s.renderedSentence}, ${s.durationMs},
          ${s.failureContext === null ? null : JSON.stringify(s.failureContext)}::jsonb,
          ${s.screenshotArtifactId}, ${s.thumbhash}, ${c.startedAt})`);
    }
  }
}

/** Monthly job (M6 observability) calls this; it is DDL, so it runs as the migration/owner role. */
export function ensureResultPartitionsSql(months: number): string {
  return `DO $$ DECLARE i int; tname text; BEGIN
    FOREACH tname IN ARRAY ARRAY['res_case_results','res_step_results'] LOOP
      FOR i IN 0..${months} LOOP
        PERFORM ensure_result_partition(tname, (date_trunc('month', now()) + (i || ' months')::interval)::date);
      END LOOP;
    END LOOP;
  END $$;`;
}
```

- [ ] **Step 5: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/results/`
Expected: PASS 9 test.

- [ ] **Step 6: Facade + commit**

```ts
// apps/core/src/modules/results/index.ts — append
export { writeCaseResults, latestCaseResults, latestStepResults, ensureResultPartitionsSql,
  RESULT_RETENTION_DAYS, type CaseResultInput, type StepResultInput } from "./results-service.js";
```

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/apps/core/src/modules/results testkite/apps/core/drizzle testkite/apps/core/test/results
git commit -m "M3-ORC T11: res_case_results/res_step_results partition thang + luat doc MAX(attempt)"
```

---

## Task 12 — Presigned PUT cho artifact (phần control plane)

Chỉ **cấp URL có hạn + ghi metadata**. Việc worker thực sự PUT lên MinIO, ring-buffer NVMe, trace retain-on-failure là **plan fleet**.

**Files:**
- Create: `apps/core/src/modules/results/s3/presign.ts`
- Create: `apps/core/src/modules/results/artifacts.ts`
- Create: `apps/core/drizzle/NNNN_m3_res_artifacts_grants.sql` (viết tay)
- Create: `apps/core/test/results/presign.test.ts`, `apps/core/test/results/artifacts.test.ts`
- Modify: `apps/core/src/modules/kernel/env.ts` (S3 config)

**Interfaces:**
- Produces:
```ts
export interface PresignInput {
  readonly method: "PUT" | "GET"; readonly endpoint: string;  // https://minio.internal:9000
  readonly bucket: string; readonly key: string; readonly region: string;
  readonly accessKey: string; readonly secretKey: string;
  readonly expiresSeconds: number; readonly now: Date;
}
export declare function presignS3Url(input: PresignInput): string;
export const ARTIFACT_URL_TTL_SECONDS = 900;
export declare function createArtifactUpload(tx: TkTx, ctx: TenantContext, input: {
  readonly jobRunId: string; readonly attempt: number;
  readonly kind: "trace" | "screenshot" | "screenshot_bundle" | "video" | "log";
  readonly contentType: string; readonly sizeBytes: number; readonly sha256: string; readonly now: Date;
}, deps: S3Config): Promise<{ readonly artifactId: string; readonly url: string; readonly headers: Record<string, string>; readonly expiresAt: Date }>;
```

- [ ] **Step 1: Viết test ĐỎ — đối chiếu test vector CHÍNH THỨC của AWS**

```ts
// apps/core/test/results/presign.test.ts
import { describe, expect, it } from "vitest";
import { presignS3Url } from "../../src/modules/results/s3/presign.js";

describe("SigV4 presign", () => {
  it("reproduces the signature from the AWS documentation's own test vector", () => {
    // GET presigned URL, examplebucket/test.txt, 20130524T000000Z, 86400s, us-east-1.
    // Matching this exact hex is what proves the implementation, not a round-trip against
    // our own code (which would happily agree with its own mistake).
    const url = presignS3Url({
      method: "GET", endpoint: "https://examplebucket.s3.amazonaws.com", bucket: "",
      key: "/test.txt", region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs a PUT for a tenant-scoped key and stamps the expiry", () => {
    const url = presignS3Url({
      method: "PUT", endpoint: "https://minio.internal:9000", bucket: "tk-artifacts",
      key: "team-a/run-1/chain-1/trace.zip", region: "us-east-1",
      accessKey: "k", secretKey: "s", expiresSeconds: 900, now: new Date("2026-08-29T10:15:00Z"),
    });
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-Date=20260829T101500Z");
    expect(url).toContain("/tk-artifacts/team-a/run-1/chain-1/trace.zip?");
  });

  it("escapes a key with characters that would otherwise break the canonical request", () => {
    const url = presignS3Url({ method: "PUT", endpoint: "https://minio.internal:9000", bucket: "b",
      key: "team a/step 1+2.webp", region: "us-east-1", accessKey: "k", secretKey: "s",
      expiresSeconds: 60, now: new Date("2026-08-29T10:15:00Z") });
    expect(url).toContain("/b/team%20a/step%201%2B2.webp?");
  });

  it("produces a different signature for a different key (no accidental constant)", () => {
    const base = { method: "PUT" as const, endpoint: "https://m:9000", bucket: "b", region: "us-east-1",
      accessKey: "k", secretKey: "s", expiresSeconds: 60, now: new Date("2026-08-29T10:15:00Z") };
    expect(presignS3Url({ ...base, key: "a" })).not.toBe(presignS3Url({ ...base, key: "b" }));
  });
});
```

```ts
// apps/core/test/results/artifacts.test.ts
describe("artifact upload slot", () => {
  it("records metadata as `pending` and hands back a 15-minute URL", async () => { /* ... */ });
  it("puts the team id in the object key so a leaked key cannot name another tenant's object", async () => { /* ... */ });
  it("refuses a size over the per-artifact cap instead of signing it", async () => { /* ... */ });
  it("404s when the job belongs to another team", async () => { /* ... */ });
});
```

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/results/presign.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: `presign.ts`**

```ts
// apps/core/src/modules/results/s3/presign.ts
/**
 * AWS SigV4 query-string presigning, ~40 lines of node:crypto.
 *
 * Why not @aws-sdk/s3-request-presigner or the minio SDK: we sign ONE kind of request. The
 * SDK would add a dependency tree bigger than this module for a function we can verify
 * exactly — the test pins AWS's own published test vector, so a mistake here is a red test,
 * not a mystery 403 from MinIO. Measured 2026-08-29: 10k presigns in 311.7ms (~31us each).
 */
import { createHash, createHmac } from "node:crypto";

const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string): Buffer => createHmac("sha256", key).update(s).digest();

/**
 * encodeURIComponent leaves !'()* alone, but SigV4's canonical form requires them percent-encoded.
 * A key containing an apostrophe would otherwise sign correctly here and be rejected by the store.
 */
const enc = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  readonly method: "PUT" | "GET";
  readonly endpoint: string;
  readonly bucket: string;
  readonly key: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly expiresSeconds: number;
  readonly now: Date;
}

export function presignS3Url(input: PresignInput): string {
  const url = new URL(input.endpoint);
  const host = url.host;
  const path = input.bucket === ""
    ? (input.key.startsWith("/") ? input.key : `/${input.key}`)
    : `/${input.bucket}/${input.key}`;
  // Each path SEGMENT is encoded; the separators stay separators.
  const canonicalPath = path.split("/").map((seg) => enc(seg)).join("/");
  const amzDate = `${input.now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k] ?? "")}`).join("&");
  const canonicalRequest = [
    input.method, canonicalPath, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, date), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `${url.origin}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
```

- [ ] **Step 4: `res_artifacts` + `artifacts.ts`**

Bảng (migration TAG `m3_res_artifacts`, sinh bằng drizzle-kit từ `results/db/artifact-schema.ts`): `team_id, id, job_run_id, attempt, kind, object_key, content_type, size_bytes, sha256, status ('pending'|'uploaded'), created_at, uploaded_at`, `UNIQUE(team_id, id)`, composite FK `(team_id, job_run_id) -> job_runs`, index `(team_id, job_run_id, attempt)`, RLS `tenant_isolation`. GRANT viết tay: `GRANT SELECT, INSERT, UPDATE ON res_artifacts TO "testkite_app";`

```ts
// apps/core/src/modules/results/artifacts.ts
export const ARTIFACT_URL_TTL_SECONDS = 900;         // 15 minutes — long enough for a 2GB trace on a slow link
export const ARTIFACT_MAX_BYTES = 2_147_483_647;

/**
 * The object key STARTS WITH THE TEAM ID. Two reasons, both load-bearing:
 *   1. a leaked or replayed URL still cannot name another tenant's object — the signature
 *      covers the path, so changing the prefix invalidates it;
 *   2. lifecycle rules and per-team retention (artifact_retention_days) are prefix rules.
 */
function objectKey(teamId: string, jobRunId: string, attempt: number, artifactId: string, kind: string): string {
  return `${teamId}/${jobRunId}/${String(attempt)}/${kind}/${artifactId}`;
}
```

`createArtifactUpload` = INSERT metadata (status `pending`) trong transaction của tenant → gọi `presignS3Url` → trả `{ artifactId, url, headers: { "Content-Type": contentType }, expiresAt }` (HTTP **200**, đúng như plan fleet giả định). Đánh dấu `uploaded` khi worker báo qua event `screenshot` hoặc mảng `artifacts[]` của `complete` (Task 13).

- [ ] **Step 5: Biến env S3**

```ts
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET_ARTIFACTS: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
```

- [ ] **Step 6: Chạy test XANH + commit**

Run: `cd testkite && pnpm --filter @testkite/core test test/results/`
Expected: PASS (4 presign + 4 artifacts + 9 của Task 11).

```bash
git add testkite/apps/core/src testkite/apps/core/drizzle testkite/apps/core/test/results
git commit -m "M3-ORC T12: presigned PUT bang node:crypto (khop test vector AWS) + res_artifacts metadata"
```

---

## Task 13 — Internal plane `/internal/fleet`: 7 endpoint, epoch bắt buộc, contract test từng cái

Đây là **hợp đồng plan fleet code theo** (mục "Hợp đồng cho plan fleet" ở đầu plan) — đường dẫn, tên trường và mã lỗi lấy đúng như plan fleet đã giả định, để bên đó chỉ phải sửa 5 điểm đã liệt kê. Mỗi endpoint mutation có contract test khẳng định: thiếu `leaseEpoch` ⇒ 400, sai ⇒ 409, job team khác ⇒ 404, sai loại token ⇒ 401.

**Files:**
- Create: `packages/contract/src/routes/internal.ts` (descriptor + zod DTO, export `INTERNAL_ROUTES`)
- Create: `apps/core/src/modules/orchestration/internal/app.ts`
- Create: `apps/core/src/modules/orchestration/internal/routes.ts`
- Create: `apps/core/test/harness/internal.ts`
- Create: `apps/core/test/orchestration/internal-contract.test.ts`
- Create: `apps/core/test/orchestration/internal-coverage.test.ts`
- Modify: `packages/contract/src/errors.ts` (thêm `StaleEpochError`, `JobTerminalError`, `JobCancelledError`), `packages/contract/src/index.ts`

**Interfaces:**
- Consumes: `claimJobs`/`completeJob`/`heartbeatJob` (T5), `recordRunEvent` (T10), `writeCaseResults` (T11), `createArtifactUpload` (T12), `registerWorker`/`verifyWorkerToken`/`touchWorker`/`mintRunToken`/`verifyRunToken`/`revokeRunTokensFor` (T9).
- Produces:
```ts
// packages/contract/src/routes/internal.ts
export type InternalCredential = "bootstrap" | "worker" | "run";
export type InternalRouteDescriptor = RouteDescriptor & { readonly credential: InternalCredential };
export const INTERNAL_ROUTES: readonly InternalRouteDescriptor[];
export const registerRequestSchema, registerResponseSchema, workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema, claimRequestSchema, claimedJobSchema, jobHeartbeatRequestSchema,
  jobHeartbeatResponseSchema, eventRequestSchema, eventResponseSchema, artifactRequestSchema,
  artifactResponseSchema, completeRequestSchema, completeResponseSchema;
export const RUN_EVENT_KIND_VALUES: readonly string[];
// apps/core/src/modules/orchestration/internal/app.ts
export declare function buildInternalApp(deps: {
  readonly env: KernelEnv; readonly db: TkDb; readonly bootstrapTokenHash: Buffer;
}): Promise<FastifyInstance>;
```

- [ ] **Step 1: Ba lớp lỗi trong contract**

```ts
// packages/contract/src/errors.ts — append after ConflictError
/**
 * 409 with its OWN code, distinct from a generic CONFLICT: the worker branches on this exact
 * string. STALE_EPOCH means "you were reaped, another attempt owns this chain now" — the
 * worker must drop everything, close its context in `finally`, and never write again.
 */
export class StaleEpochError extends AppError {
  readonly code = "STALE_EPOCH";
  readonly httpStatus = 409;
  readonly retryable = false;
  readonly tenantVisible = false;
  readonly currentEpoch: number;
  constructor(message: string, currentEpoch: number) {
    super(message);
    this.currentEpoch = currentEpoch;
  }
  override publicExtras(): Readonly<Record<string, unknown>> {
    return { currentEpoch: this.currentEpoch };
  }
}

/** 410 — the run was cancelled while the worker was mid-chain. Abandon, do NOT complete. */
export class JobCancelledError extends AppError {
  readonly code = "JOB_CANCELLED";
  readonly httpStatus = 410;
  readonly retryable = false;
  readonly tenantVisible = false;
}

/** 410 — the job already succeeded or failed; nothing more can be written to it. */
export class JobTerminalError extends AppError {
  readonly code = "JOB_TERMINAL";
  readonly httpStatus = 410;
  readonly retryable = false;
  readonly tenantVisible = false;
}
```

`EpochOutcome` của T5 đã có sẵn hai nhánh 410 (`"cancelled"` và `"terminal"`) — `unwrap()` dưới đây ánh xạ chúng sang đúng hai lớp lỗi này.

- [ ] **Step 2: Viết test ĐỎ — contract test cho TỪNG endpoint**

```ts
// apps/core/test/orchestration/internal-contract.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { makeInternalTestApp, type InternalTestApp } from "../harness/internal.js";

describe("/internal/fleet — leaseEpoch is mandatory on every mutation", () => {
  let h: InternalTestApp;
  beforeEach(async () => { h = await makeInternalTestApp(); });

  // The four mutating endpoints, driven from one table so a NEW endpoint cannot be added
  // without also being covered here (internal-coverage.test.ts enforces that).
  const MUTATIONS = [
    { name: "heartbeat", path: (j: string) => `/internal/fleet/jobs/${j}/heartbeat`, body: {} },
    { name: "events", path: (j: string) => `/internal/fleet/jobs/${j}/events`,
      body: { seq: 1, kind: "chain_started", payload: {} } },
    { name: "artifacts", path: (j: string) => `/internal/fleet/jobs/${j}/artifacts`,
      body: { kind: "trace", contentType: "application/zip", sizeBytes: 10, sha256: "0".repeat(64) } },
    { name: "complete", path: (j: string) => `/internal/fleet/jobs/${j}/complete`,
      body: { verdict: "passed", steps: [], artifacts: [] } },
  ] as const;

  for (const m of MUTATIONS) {
    it(`${m.name}: rejects a body with no leaseEpoch at all (400)`, async () => {
      const job = await h.claimOneJob();
      const res = await h.post(m.path(job.jobRunId), m.body, job.runToken);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it(`${m.name}: rejects an epoch the reaper has already moved past (409 STALE_EPOCH)`, async () => {
      const job = await h.claimOneJob();
      await h.reapJob(job.jobRunId);
      const res = await h.post(m.path(job.jobRunId), { ...m.body, leaseEpoch: job.leaseEpoch }, job.runToken);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "STALE_EPOCH", currentEpoch: job.leaseEpoch + 1 });
    });

    it(`${m.name}: 404s a job of another team — never 403`, async () => {
      const job = await h.claimOneJob();
      const foreign = await h.jobIdOfOtherTeam();
      const res = await h.post(m.path(foreign), { ...m.body, leaseEpoch: 1 }, job.runToken);
      expect(res.statusCode).toBe(404);
    });

    it(`${m.name}: 401s a worker token — a worker token may only register and claim`, async () => {
      const job = await h.claimOneJob();
      const res = await h.post(m.path(job.jobRunId), { ...m.body, leaseEpoch: job.leaseEpoch }, h.workerToken);
      expect(res.statusCode).toBe(401);
    });

    it(`${m.name}: 401s a run token minted for a DIFFERENT job`, async () => {
      const a = await h.claimOneJob();
      const b = await h.claimOneJob();
      const res = await h.post(m.path(a.jobRunId), { ...m.body, leaseEpoch: a.leaseEpoch }, b.runToken);
      expect(res.statusCode).toBe(401);
    });

    it(`${m.name}: 410 JOB_CANCELLED once the run is aborted`, async () => {
      const job = await h.claimOneJob();
      await h.cancelRun(job.runId);
      const res = await h.post(m.path(job.jobRunId), { ...m.body, leaseEpoch: job.leaseEpoch }, job.runToken);
      expect(res.statusCode).toBe(410);
    });
  }

  it("register: needs the bootstrap token and hands back a worker token", async () => {
    const res = await h.post("/internal/fleet/workers/register",
      { workerId: "w9", hostname: "host-1", lane: "batch", capacity: 4 }, h.bootstrapToken);
    expect(res.json()).toMatchObject({ workerId: "w9", heartbeatIntervalMs: 5000, drain: false });
    expect(res.json().workerToken).toMatch(/^tkw_/);
  });

  it("register: 401s a worker token — registration is the one thing only the host may do", async () => {
    const res = await h.post("/internal/fleet/workers/register",
      { workerId: "w9", hostname: "h", lane: "batch", capacity: 4 }, h.workerToken);
    expect(res.statusCode).toBe(401);
  });

  it("worker heartbeat: answers `drain` once the worker is marked draining", async () => {
    await h.setWorkerDrain(true);
    const res = await h.post(`/internal/fleet/workers/${h.workerId}/heartbeat`,
      { freeSlots: 2, psi: { some10: 0.01, full10: 0 }, rssBytes: 1000 }, h.workerToken);
    expect(res.json()).toMatchObject({ command: "drain" });
  });

  it("worker heartbeat: 401s a token belonging to a DIFFERENT worker", async () => {
    const other = await h.registerWorker("w-other");
    const res = await h.post(`/internal/fleet/workers/${h.workerId}/heartbeat`, { freeSlots: 1 }, other.workerToken);
    expect(res.statusCode).toBe(401);
  });

  it("claim: 204 with no body when the queue is empty — not an error", async () => {
    await h.drainQueue();
    const res = await h.post("/internal/fleet/claim", { workerId: h.workerId, lane: "batch", freeSlots: 3 }, h.workerToken);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("claim: returns ONE job, the frozen plan inline, and a run token scoped to that attempt", async () => {
    const res = await h.post("/internal/fleet/claim", { workerId: h.workerId, lane: "batch", freeSlots: 3 }, h.workerToken);
    expect(res.statusCode).toBe(200);
    const job = res.json();
    expect(job).toMatchObject({ attempt: 1, leaseEpoch: 1 });
    expect(job.runToken).toMatch(/^tkr_/);
    expect(job.plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.leaseDeadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("claim: 401s a run token — a run token cannot ask for more work", async () => {
    const job = await h.claimOneJob();
    const res = await h.post("/internal/fleet/claim", { workerId: h.workerId, lane: "batch", freeSlots: 1 }, job.runToken);
    expect(res.statusCode).toBe(401);
  });

  it("events: a replayed seq answers 202 duplicate=true, not an error", async () => {
    const job = await h.claimOneJob();
    const body = { leaseEpoch: job.leaseEpoch, seq: 1, kind: "chain_started", payload: {} };
    expect((await h.post(`/internal/fleet/jobs/${job.jobRunId}/events`, body, job.runToken)).json())
      .toMatchObject({ duplicate: false });
    expect((await h.post(`/internal/fleet/jobs/${job.jobRunId}/events`, body, job.runToken)).json())
      .toMatchObject({ duplicate: true });
  });

  it("events: 400s a kind outside the closed enum", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(`/internal/fleet/jobs/${job.jobRunId}/events`,
      { leaseEpoch: job.leaseEpoch, seq: 1, kind: "made_up", payload: {} }, job.runToken);
    expect(res.statusCode).toBe(400);
  });

  it("artifacts: signs a 15-minute PUT and refuses a size over the cap", async () => {
    const job = await h.claimOneJob();
    const ok = await h.post(`/internal/fleet/jobs/${job.jobRunId}/artifacts`,
      { leaseEpoch: job.leaseEpoch, kind: "trace", contentType: "application/zip",
        sizeBytes: 3304, sha256: "a".repeat(64) }, job.runToken);
    expect(ok.json().url).toContain("X-Amz-Signature=");
    expect(ok.json().url).toContain(`/${job.teamId}/`);      // the key is tenant-prefixed
    const tooBig = await h.post(`/internal/fleet/jobs/${job.jobRunId}/artifacts`,
      { leaseEpoch: job.leaseEpoch, kind: "trace", contentType: "application/zip",
        sizeBytes: 3_000_000_000, sha256: "a".repeat(64) }, job.runToken);
    expect(tooBig.statusCode).toBe(400);
  });

  it("complete: an assertion failure is terminal and writes the results", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, {
      leaseEpoch: job.leaseEpoch, verdict: "failed", steps: [h.sampleStep()], artifacts: [],
    }, job.runToken);
    expect(res.json()).toMatchObject({ ok: true, requeued: false });
    expect(await h.caseResultCount(job.jobRunId)).toBe(1);
  });

  it("complete: an infraError requeues, bumps attempt, and revokes the run token on the spot", async () => {
    const job = await h.claimOneJob();
    const res = await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, {
      leaseEpoch: job.leaseEpoch,
      infraError: { code: "browser_oom", retryable: true, message: "killed", peakRssBytes: 1728053248 },
    }, job.runToken);
    expect(res.json()).toMatchObject({ ok: true, requeued: true, attempt: 2 });
    // The token died with the lease: the next call is 401, not 409.
    const after = await h.post(`/internal/fleet/jobs/${job.jobRunId}/heartbeat`, { leaseEpoch: 2 }, job.runToken);
    expect(after.statusCode).toBe(401);
  });

  it("complete: writes NO result when the epoch is stale — the whole call rolls back", async () => {
    const job = await h.claimOneJob();
    await h.reapJob(job.jobRunId);
    const res = await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, {
      leaseEpoch: job.leaseEpoch, verdict: "passed", steps: [h.sampleStep()], artifacts: [],
    }, job.runToken);
    expect(res.statusCode).toBe(409);
    expect(await h.caseResultCount(job.jobRunId), "a zombie must not leave a verdict behind").toBe(0);
  });

  it("complete: a second complete on a finished job answers 410 JOB_TERMINAL", async () => {
    const job = await h.claimOneJob();
    const body = { leaseEpoch: job.leaseEpoch, verdict: "passed", steps: [], artifacts: [] };
    await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, body, job.runToken);
    const again = await h.post(`/internal/fleet/jobs/${job.jobRunId}/complete`, body, job.runToken);
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: "JOB_TERMINAL" });
  });

  it("serves /internal/fleet on its own instance and never mounts /v1 there", async () => {
    expect((await h.get("/v1/runs", h.workerToken)).statusCode).toBe(404);
  });
});
```

```ts
// apps/core/test/orchestration/internal-coverage.test.ts
/**
 * The same gate idea as test/isolation/coverage.test.ts: a NEW /internal/fleet endpoint that
 * nobody wrote a contract test for would ship unguarded. This turns that silence red.
 * Static check on the descriptor list — no app, no DB, runs in milliseconds.
 */
import { describe, expect, it } from "vitest";
import { INTERNAL_ROUTES, ROUTES, RUN_EVENT_KIND_VALUES } from "@testkite/contract";
import { RUN_EVENT_KINDS } from "../../src/modules/orchestration/events.js";

/** Endpoints that mutate a job and therefore MUST carry leaseEpoch. */
const EPOCH_REQUIRED = ["internalJobHeartbeat", "internalEvents", "internalArtifacts", "internalComplete"];
const EPOCH_EXEMPT: Record<string, string> = {
  internalRegister: "registration happens before any job exists, so there is no lease to fence",
  internalWorkerHeartbeat: "a worker-level heartbeat is about the host, not about any one job's lease",
  internalClaim: "the claim is what CREATES the epoch; requiring one would be circular",
};

describe("/internal/fleet route coverage", () => {
  it("every mutating route requires leaseEpoch in its body schema", () => {
    for (const op of EPOCH_REQUIRED) {
      const r = INTERNAL_ROUTES.find((x) => x.operationId === op);
      expect(r, `${op} is missing from INTERNAL_ROUTES`).toBeDefined();
      expect(Object.keys(r?.body?.shape ?? {}), `${op} body must carry leaseEpoch`).toContain("leaseEpoch");
    }
  });

  it("every route is either epoch-required or exempt with a written reason", () => {
    for (const r of INTERNAL_ROUTES) {
      const covered = EPOCH_REQUIRED.includes(r.operationId) || EPOCH_EXEMPT[r.operationId] !== undefined;
      expect(covered, `${r.operationId}: add it to EPOCH_REQUIRED or justify it in EPOCH_EXEMPT`).toBe(true);
    }
    for (const [op, reason] of Object.entries(EPOCH_EXEMPT)) {
      expect(reason.length, `${op}: reason is too short`).toBeGreaterThan(30);
    }
  });

  it("declares a credential kind on every route", () => {
    for (const r of INTERNAL_ROUTES) expect(["bootstrap", "worker", "run"]).toContain(r.credential);
  });

  it("keeps every path under /internal/fleet and out of the public ROUTES array", () => {
    for (const r of INTERNAL_ROUTES) expect(r.path.startsWith("/internal/fleet/")).toBe(true);
    expect(ROUTES.some((r) => r.path.startsWith("/internal"))).toBe(false);
  });

  it("keeps the event-kind list identical on both sides of the module boundary", () => {
    // contract cannot import apps/core, so the list exists twice; this is the only thing
    // stopping the two copies from drifting.
    expect([...RUN_EVENT_KIND_VALUES]).toEqual([...RUN_EVENT_KINDS]);
  });
});
```

- [ ] **Step 3: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/internal-`
Expected: FAIL — `INTERNAL_ROUTES` chưa tồn tại.

- [ ] **Step 4: Descriptor + DTO trong contract**

```ts
// packages/contract/src/routes/internal.ts
/**
 * The internal fleet plane. Same descriptor shape as the public routes (so the router, the
 * auth hook and the coverage gate all read one source), but deliberately NOT part of ROUTES:
 *   - openapi.json describes the TENANT API; /internal/fleet is an implementation detail
 *     between the control plane and its own workers, and publishing it invites people to call it;
 *   - the L3 isolation harness drives team credentials, which this plane does not accept at
 *     all — its cross-tenant guarantee is proven by internal-contract.test.ts instead.
 */
import { z } from "zod";
import { defineRoute, type RouteDescriptor } from "./types.js";

export type InternalCredential = "bootstrap" | "worker" | "run";
export type InternalRouteDescriptor = RouteDescriptor & { readonly credential: InternalCredential };

const jobParams = z.object({ jobRunId: z.string().uuid() });
const workerParams = z.object({ workerId: z.string().min(1).max(128) });
/** Every job mutation carries it. NOT optional — a missing leaseEpoch is a 400, never a default. */
const leaseEpoch = z.number().int().nonnegative();
const lane = z.enum(["interactive", "batch"]);

export const registerRequestSchema = z.object({
  workerId: z.string().min(1).max(128), hostname: z.string().min(1).max(255),
  lane, capacity: z.number().int().min(1).max(16),
});
export const registerResponseSchema = z.object({
  workerId: z.string(), lane, workerToken: z.string(),
  heartbeatIntervalMs: z.number().int().positive(), drain: z.boolean(),
});

export const workerHeartbeatRequestSchema = z.object({
  freeSlots: z.number().int().nonnegative(),
  psi: z.object({ some10: z.number(), full10: z.number() }).optional(),
  rssBytes: z.number().int().nonnegative().optional(),
});
export const workerHeartbeatResponseSchema = z.object({
  command: z.enum(["continue", "drain"]), workerTokenRenewedAt: z.string(),
});

export const claimRequestSchema = z.object({
  workerId: z.string().min(1).max(128), lane, freeSlots: z.number().int().min(1).max(16),
});
export const claimedJobSchema = z.object({
  jobRunId: z.string().uuid(), runId: z.string().uuid(), teamId: z.string().uuid(),
  projectId: z.string().uuid(), chainKey: z.string(),
  attempt: z.number().int().positive(), leaseEpoch: z.number().int().positive(),
  leaseDeadlineAt: z.string(), runToken: z.string(),
  /** The frozen RunPlan, verbatim. `unknown` here on purpose: contract must not import run-compiler. */
  plan: z.unknown(),
});

export const jobHeartbeatRequestSchema = z.object({ leaseEpoch });
export const jobHeartbeatResponseSchema = z.object({
  leaseDeadlineAt: z.string(), command: z.enum(["continue", "drain", "cancel"]),
});

export const RUN_EVENT_KIND_VALUES = ["chain_started", "case_started", "case_finished",
  "step_started", "step_finished", "screenshot", "infra_error"] as const;
export const eventRequestSchema = z.object({
  leaseEpoch, seq: z.number().int().min(1),
  kind: z.enum(RUN_EVENT_KIND_VALUES), payload: z.record(z.unknown()).default({}),
});
export const eventResponseSchema = z.object({ accepted: z.boolean(), duplicate: z.boolean() });

export const artifactRequestSchema = z.object({
  leaseEpoch, kind: z.enum(["trace", "screenshot", "screenshot_bundle", "video", "log"]),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(2_147_483_647),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const artifactResponseSchema = z.object({
  artifactId: z.string().uuid(), method: z.literal("PUT"), url: z.string(),
  headers: z.record(z.string()), expiresAt: z.string(),
});

/**
 * One step row per executed step, FLAT (carrying caseId) rather than nested per case — this is
 * the shape the fleet plan's worker already produces; the server groups by caseId when writing
 * res_case_results. The four presentation fields default so a worker that does not collect
 * screenshots still passes validation.
 */
export const completedStepSchema = z.object({
  caseId: z.string().uuid(), ordinal: z.number().int().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().int().nonnegative(),
  renderedSentence: z.string().default(""),
  failureContext: z.record(z.unknown()).nullable().default(null),
  screenshotArtifactId: z.string().uuid().nullable().default(null),
  thumbhash: z.string().nullable().default(null),
});
export const completedArtifactSchema = z.object({
  kind: z.enum(["trace", "screenshot", "screenshot_bundle", "video", "log"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().nonnegative(),
});
export const infraErrorSchema = z.object({
  code: z.enum(["browser_oom", "context_crash", "host_death", "lease_expired", "network"]),
  retryable: z.boolean(),
  message: z.string().max(2048),
  peakRssBytes: z.number().int().nonnegative().optional(),
});
export const completeRequestSchema = z.object({
  leaseEpoch,
  verdict: z.enum(["passed", "failed", "aborted_early", "cancelled"]).optional(),
  infraError: infraErrorSchema.nullable().default(null),
  steps: z.array(completedStepSchema).default([]),
  artifacts: z.array(completedArtifactSchema).default([]),
}).refine((b) => b.verdict !== undefined || b.infraError !== null, {
  // Exactly one of the two shapes from the contract. Neither = the worker told us nothing.
  message: "complete requires either a verdict or an infraError",
});
export const completeResponseSchema = z.object({
  ok: z.literal(true), requeued: z.boolean(), attempt: z.number().int().positive(),
});

const errorSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string() });
const jobErrors = { 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 410: errorSchema };
const internal = <T extends InternalRouteDescriptor>(r: T): T => r;

export const INTERNAL_ROUTES: readonly InternalRouteDescriptor[] = [
  internal({ ...defineRoute({ operationId: "internalRegister", method: "post",
    path: "/internal/fleet/workers/register", summary: "Register a worker with the fleet",
    auth: "required", permission: null, body: registerRequestSchema,
    responses: { 200: registerResponseSchema, 401: errorSchema } }), credential: "bootstrap" }),
  internal({ ...defineRoute({ operationId: "internalWorkerHeartbeat", method: "post",
    path: "/internal/fleet/workers/{workerId}/heartbeat", summary: "Worker liveness + PSI, returns a command",
    auth: "required", permission: null, params: workerParams, body: workerHeartbeatRequestSchema,
    responses: { 200: workerHeartbeatResponseSchema, 401: errorSchema, 404: errorSchema } }), credential: "worker" }),
  internal({ ...defineRoute({ operationId: "internalClaim", method: "post",
    path: "/internal/fleet/claim", summary: "Claim one job for a lane",
    auth: "required", permission: null, body: claimRequestSchema,
    responses: { 200: claimedJobSchema, 204: z.undefined(), 401: errorSchema } }), credential: "worker" }),
  internal({ ...defineRoute({ operationId: "internalJobHeartbeat", method: "post",
    path: "/internal/fleet/jobs/{jobRunId}/heartbeat", summary: "Renew the lease on a running job",
    auth: "required", permission: null, params: jobParams, body: jobHeartbeatRequestSchema,
    responses: { 200: jobHeartbeatResponseSchema, ...jobErrors } }), credential: "run" }),
  internal({ ...defineRoute({ operationId: "internalEvents", method: "post",
    path: "/internal/fleet/jobs/{jobRunId}/events", summary: "Report one run event (idempotent by seq)",
    auth: "required", permission: null, params: jobParams, body: eventRequestSchema,
    responses: { 202: eventResponseSchema, ...jobErrors } }), credential: "run" }),
  internal({ ...defineRoute({ operationId: "internalArtifacts", method: "post",
    path: "/internal/fleet/jobs/{jobRunId}/artifacts", summary: "Get a presigned PUT URL for an artifact",
    auth: "required", permission: null, params: jobParams, body: artifactRequestSchema,
    responses: { 200: artifactResponseSchema, ...jobErrors } }), credential: "run" }),
  internal({ ...defineRoute({ operationId: "internalComplete", method: "post",
    path: "/internal/fleet/jobs/{jobRunId}/complete", summary: "Finish a job with a verdict or an infra error",
    auth: "required", permission: null, params: jobParams, body: completeRequestSchema,
    responses: { 200: completeResponseSchema, ...jobErrors } }), credential: "run" }),
];
```

- [ ] **Step 5: App `/internal/fleet` + hook auth ba loại token**

```ts
// apps/core/src/modules/orchestration/internal/app.ts
/**
 * A SEPARATE Fastify instance on its own port (INTERNAL_PORT, bound to INTERNAL_HOST which
 * defaults to 127.0.0.1). Not a prefix on the public app, because the two have nothing in
 * common: different credentials, different error taxonomy, and the public app is the one that
 * faces the internet. A network policy can simply not expose this port.
 *
 * The auth hook reads `config.tkInternal` exactly like installAuth reads `config.tk` for /v1
 * (M2 pattern), so a route registered without a descriptor is a route with NO credential
 * check — and internal-coverage.test.ts is what makes that impossible to ship.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { UnauthorizedError, type InternalRouteDescriptor } from "@testkite/contract";
import { verifyRunToken, verifyWorkerToken, type RunTokenScope, type WorkerTokenScope } from "../run-token.js";
import { installErrorHandler } from "../../../http/errors.js";
import { internalRoutes } from "./routes.js";
import type { KernelEnv, TkDb } from "../../kernel/index.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on a run-credential route; null elsewhere. */
    tkRun: RunTokenScope | null;
    /** Set on a worker-credential route; null elsewhere. */
    tkWorker: WorkerTokenScope | null;
  }
  interface FastifyContextConfig {
    readonly tkInternal?: InternalRouteDescriptor;
  }
}

export async function buildInternalApp(deps: {
  readonly env: KernelEnv;
  readonly db: TkDb;
  readonly bootstrapTokenHash: Buffer;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL },
    genReqId: () => randomUUID(),
    // A complete() payload carries every step of a chain; 1MB is not enough, 8MB is.
    bodyLimit: 8 * 1_048_576,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);
  app.decorateRequest("tkRun", null);
  app.decorateRequest("tkWorker", null);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.addHook("onRequest", async (req) => {
    const descriptor = req.routeOptions.config?.tkInternal;
    if (descriptor === undefined) return;              // /healthz and the 404 router
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (m === null || m[1] === undefined) throw new UnauthorizedError("missing or malformed Authorization");
    const presented = m[1];

    if (descriptor.credential === "bootstrap") {
      const hash = createHash("sha256").update(presented).digest();
      // Constant-time compare: the bootstrap token is long-lived and shared per host, so a
      // timing oracle on it is worth closing.
      if (hash.length !== deps.bootstrapTokenHash.length || !timingSafeEqual(hash, deps.bootstrapTokenHash)) {
        throw new UnauthorizedError("invalid bootstrap credential");
      }
      return;
    }

    if (descriptor.credential === "worker") {
      const scope = await verifyWorkerToken(deps.db, presented, new Date());
      if (scope === null) throw new UnauthorizedError("invalid worker credential");
      // A worker token names ONE worker; using it on another worker's path is a 401, not a 404
      // (a 404 would confirm whether that worker exists).
      const wanted = (req.params as { workerId?: string }).workerId;
      if (wanted !== undefined && wanted !== scope.workerId) throw new UnauthorizedError("worker scope mismatch");
      req.tkWorker = scope;
      return;
    }

    const scope = await verifyRunToken(deps.db, presented, new Date());
    if (scope === null) throw new UnauthorizedError("invalid run credential");
    const wanted = (req.params as { jobRunId?: string }).jobRunId;
    // Presenting a run token for a different job is not a 404 (that would confirm the other
    // job exists) and not a 409 — it is a credential that does not apply here.
    if (wanted !== undefined && wanted !== scope.jobRunId) throw new UnauthorizedError("run scope mismatch");
    req.tkRun = scope;
  });

  await app.register(internalRoutes(deps.db, deps.env));
  return app;
}
```

- [ ] **Step 6: Handler — `internal/routes.ts`**

Đăng ký kiểu plugin (giống authoring), mỗi route `config: { tkInternal: descriptor }`. Ánh xạ `EpochOutcome` → HTTP là **một hàm dùng chung**, không lặp ở 4 handler:

```ts
/**
 * ONE place turns a queue outcome into an HTTP answer. Repeating this per handler is how a
 * single endpoint ends up answering 403 for a cross-tenant id while the rest answer 404.
 */
function unwrap<T>(outcome: EpochOutcome<T>): T {
  if (outcome.ok) return outcome.value;
  switch (outcome.reason) {
    case "not_found": throw new NotFoundError("job not found");
    case "cancelled": throw new JobCancelledError("run was cancelled");
    case "terminal": throw new JobTerminalError("job already finished");
    case "stale_epoch": throw new StaleEpochError("lease epoch is stale", outcome.currentEpoch);
  }
}

/**
 * The body's leaseEpoch must equal the epoch baked into the run token. They can only differ
 * if the worker kept an old token or hand-edited the body; either way it is the same verdict
 * as a stale write, so it answers 409 (not 401) — the worker's STALE_EPOCH branch already
 * knows to stop.
 */
function assertEpochMatchesToken(bodyEpoch: number, scope: RunTokenScope): void {
  if (bodyEpoch !== scope.leaseEpoch) throw new StaleEpochError("leaseEpoch does not match the run token", scope.leaseEpoch);
}
```

Ràng buộc cài đặt của từng handler:

| Endpoint | Việc phải làm |
|---|---|
| `internalRegister` | `registerWorker(db, body)` → `{ workerId, lane, workerToken, heartbeatIntervalMs: 5000, drain }` |
| `internalWorkerHeartbeat` | `touchWorker(db, { workerId, freeSlots, now })` → `{ command, workerTokenRenewedAt }` |
| `internalClaim` | `claimJobs(db, { workerId, lane, max: 1 })`. Rỗng ⇒ `reply.code(204).send()`. Có job ⇒ `withTenant(db, { teamId }, tx => mintRunToken(...))` với `expiresAt = leaseExpiresAt + RUN_TOKEN_TTL_SLACK_SECONDS`, đọc `orc_run_plans.plan` theo `run_id`, trả một object `ClaimedJob` (KHÔNG bọc mảng) |
| `internalJobHeartbeat` | `assertEpochMatchesToken` → `withTenant` → `unwrap(await heartbeatJob(...))` → `{ leaseDeadlineAt, command }` |
| `internalEvents` | `assertEpochMatchesToken` → `recordRunEvent` → 202 |
| `internalArtifacts` | `assertEpochMatchesToken` → `createArtifactUpload` → 200 |
| `internalComplete` | MỘT transaction `withTenant`: nhóm `steps[]` theo `caseId` → `writeCaseResults` → `completeJob` (verdict hoặc `infraError`) → `revokeRunTokensFor` → đánh dấu `res_artifacts` đã upload. `completeJob` trả stale/cancelled/terminal ⇒ **ném lỗi bên trong transaction ⇒ ROLLBACK**, nên kết quả không bao giờ tồn tại dưới epoch cũ (có test riêng) |

- [ ] **Step 7: Chạy test, xác nhận XANH**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/internal-`
Expected: PASS (24 contract + 5 coverage).

- [ ] **Step 8: Commit**

```bash
cd testkite && pnpm typecheck && pnpm --filter @testkite/core test
git add testkite/packages/contract testkite/apps/core/src testkite/apps/core/test
git commit -m "M3-ORC T13: internal plane /internal/fleet — 7 endpoint, leaseEpoch bat buoc, contract test tung endpoint"
```

---

## Task 14 — Route `/v1/runs*` công khai + SSE trạng thái run

**Files:**
- Create: `packages/contract/src/routes/orchestration.ts`
- Create: `apps/core/src/modules/orchestration/routes.ts`
- Create: `apps/core/src/modules/orchestration/sse.ts`
- Create: `apps/core/test/orchestration/run-routes.test.ts`, `apps/core/test/orchestration/sse.test.ts`
- Modify: `packages/contract/src/routes/index.ts` (nối `...orchestrationRoutes` vào CUỐI `ROUTES`)

**Interfaces:**
- Produces: descriptor `triggerRun` (POST `/v1/runs`, perm `run:trigger`), `getRun` (GET `/v1/runs/{runId}`, `run:read`), `abortRun` (POST `/v1/runs/{runId}/abort`, `run:abort`), `streamRun` (GET `/v1/runs/{runId}/stream`, `run:read`); `orchestrationRoutes(db, deps): FastifyPluginAsync`.

- [ ] **Step 1: Viết test ĐỎ**

```ts
// apps/core/test/orchestration/sse.test.ts
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../harness/http.js";

describe("GET /v1/runs/:runId/stream", () => {
  it("answers with an SSE content type and a heartbeat comment first", async () => {
    const h = await makeTestApp();
    const runId = await h.seedRun();
    const res = await h.injectStream(`/v1/runs/${runId}/stream`, h.tokens.authorA);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.body.startsWith(": ")).toBe(true);
  });

  it("emits one `status` frame per poll and a terminal `done` frame when the run finishes", async () => {
    // Spike 2026-08-29: Fastify 5 needs NO SSE plugin — reply.hijack() + reply.raw.write().
    const frames = await h.collectStream(`/v1/runs/${runId}/stream`, h.tokens.authorA, { untilEvent: "done" });
    expect(frames.map((f) => f.event)).toContain("status");
    expect(frames.at(-1)?.event).toBe("done");
  });

  it("resumes from Last-Event-ID instead of replaying the whole run", async () => {
    const frames = await h.collectStream(`/v1/runs/${runId}/stream`, h.tokens.authorA, { lastEventId: "3" });
    expect(frames.every((f) => Number(f.id) > 3)).toBe(true);
  });

  it("closes its poll timer when the client goes away", async () => {
    // Measured: req.raw.on("close") fires and clearInterval runs; 0 timers left holding the loop.
    const before = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await h.abortStreamEarly(`/v1/runs/${runId}/stream`, h.tokens.authorA);
    expect(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length).toBe(before);
  });

  it("404s another team's run rather than streaming it", async () => {
    const res = await h.injectStream(`/v1/runs/${runId}/stream`, h.tokens.adminB);
    expect(res.statusCode).toBe(404);
  });

  it("401s without a credential — the auth hook runs BEFORE the hijack", async () => {
    const res = await h.injectStream(`/v1/runs/${runId}/stream`, null);
    expect(res.statusCode).toBe(401);
  });
});
```

`run-routes.test.ts`: trigger 202 + `runId`; trigger với case của team khác ⇒ 404; trigger khi hết quota ⇒ 429 `RATE_LIMITED`; trigger sinh diagnostics ⇒ 200 với `verdict: "compile_error"` + mảng `diagnostics`; `GET /v1/runs/{id}` của team khác ⇒ 404; abort ⇒ mọi `job_runs` chưa terminal chuyển `cancelled` + bump epoch (zombie tiếp theo ăn 409).

- [ ] **Step 2: Chạy test, xác nhận ĐỎ**

Run: `cd testkite && pnpm --filter @testkite/core test test/orchestration/sse.test.ts`
Expected: FAIL — route chưa tồn tại (404).

- [ ] **Step 3: `sse.ts`**

```ts
// apps/core/src/modules/orchestration/sse.ts
/**
 * SSE without a plugin (spike 2026-08-29 on Fastify 5.12.1): `reply.hijack()` then write to
 * `reply.raw`. Two consequences the implementer must not fight:
 *   1. hijack BYPASSES the response serializer, so this route cannot go through
 *      buildHttpApp's `registrations` path (that one always ends in reply.send()). It is
 *      registered plugin-style, like authoring's routes, with `config: { tk: descriptor }`
 *      so the auth hook still covers it — measured: the onRequest hook runs before the hijack.
 *   2. NOTHING closes the connection for us. `req.raw.on("close")` is where the interval dies;
 *      without it every abandoned tab leaks a timer and a DB query per second.
 *
 * v1 POLLS the DB once a second. LISTEN/NOTIFY is faster (measured 0.29-0.94ms end to end)
 * but needs a dedicated LISTEN connection per API instance plus in-process fan-out; that is
 * an M6 upgrade, and the poll is what makes v1 shippable with zero new moving parts.
 */
export const SSE_POLL_MS = 1_000;
export const SSE_HEARTBEAT_MS = 15_000;
```

Khung handler:

```ts
async function handleStream(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ctx = req.tk;
  if (ctx === null) throw new UnauthorizedError("missing auth context");
  const runId = (req.params as { runId: string }).runId;
  // Check visibility BEFORE hijacking: after the hijack there is no way to send a 404 body.
  const run = await withTenant(db, ctx, (tx) => loadRun(tx, ctx, runId));
  if (run === null) throw new NotFoundError("run not found");

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers text/* by default and would hold every frame until the run ends.
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": stream open\n\n");

  let lastId = Number(req.headers["last-event-id"] ?? 0);
  let alive = true;
  const timer = setInterval(() => { void tick(); }, SSE_POLL_MS);
  const beat = setInterval(() => { if (alive) reply.raw.write(": ping\n\n"); }, SSE_HEARTBEAT_MS);
  const close = (): void => { alive = false; clearInterval(timer); clearInterval(beat); reply.raw.end(); };
  req.raw.on("close", close);
  // ... tick(): read run status + counts + events with seq > lastId, write frames, and call
  //     close() after writing `event: done` when the run reaches a terminal verdict.
}
```

- [ ] **Step 4: Chạy test, xác nhận XANH + regen OpenAPI**

```bash
cd testkite && pnpm --filter @testkite/core test test/orchestration/
pnpm openapi:gen && git diff --stat packages/contract/openapi.json
```
Expected: test PASS; `openapi.json` chỉ thêm 4 path `/v1/runs*` (không có `/internal`).

- [ ] **Step 5: Commit**

```bash
git add testkite/packages/contract testkite/apps/core/src/modules/orchestration testkite/apps/core/test
git commit -m "M3-ORC T14: route /v1/runs (trigger/get/abort) + SSE trang thai run khong can plugin"
```

---

## Task 15 — Wiring composition root, fixture L3, gate CI

**Files:**
- Modify: `apps/core/src/composition-root.ts`, `apps/core/src/main.ts`
- Modify: `apps/core/test/isolation/fixtures.ts`
- Modify: `.github/workflows/testkite-ci.yml`
- Modify: `apps/core/test/harness/http.ts` (đăng ký `orchestrationRoutes`)

- [ ] **Step 1: Test ĐỎ — L3 cross-tenant phủ route mới**

Thêm fixture cho `runId` vào `RESOURCE_FIXTURES` và body mẫu cho `triggerRun` vào `BODY_FIXTURES` (`test/isolation/fixtures.ts`). Bộ `coverage.test.ts` sẵn có sẽ ĐỎ ngay khi `ROUTES` có route mới mà chưa có fixture — đó chính là test đỏ của bước này.

Run: `cd testkite && pnpm --filter @testkite/core test test/isolation/`
Expected: FAIL — `add a fixture to test/isolation/fixtures.ts` liệt kê `getRun -> runId`, `abortRun -> runId`, `streamRun -> runId`.

- [ ] **Step 2: Thêm fixture, chạy lại**

Expected: PASS — bộ L3 tự sinh test "token B + id A ⇒ 404" cho cả 4 route mới.

- [ ] **Step 3: Wiring composition root**

```ts
// apps/core/src/composition-root.ts — ONE block, appended at the end of buildApp
  // Orchestration serves TWO planes: /v1 (tenant) on the public app, and /internal (fleet)
  // on its own port. They are separate Fastify instances on purpose — see internal/app.ts.
  const internalApp = await buildInternalApp({
    env, db, bootstrapTokenHash: sha256(env.FLEET_BOOTSTRAP_TOKEN),
  });
  await internalApp.listen({ port: env.INTERNAL_PORT, host: env.INTERNAL_HOST });

  // The dispatcher is a background loop, not a request handler. Every API replica starts one;
  // the leader election decides which of them actually dispatches.
  const dispatcher = env.DISPATCHER_ENABLED
    ? startDispatcher(db, { holder: env.DISPATCHER_ID, hooks: dispatcherMetrics() })
    : null;

  app.addHook("onClose", async () => {
    await dispatcher?.stop();          // releases the lease, so the next process leads immediately
    await internalApp.close();
    await close();
  });
```

Env mới: `INTERNAL_PORT` (default 8081), `INTERNAL_HOST` (default `127.0.0.1` — không nghe ra ngoài trừ khi khai báo rõ), `FLEET_BOOTSTRAP_TOKEN` (bootstrap token của host, dùng đúng cho `register`).

- [ ] **Step 4: Gate CI**

Thêm vào `.github/workflows/testkite-ci.yml`, job `build-and-test`:

```yaml
      - name: Gate — /internal must not leak into the public OpenAPI
        working-directory: testkite
        run: |
          ! grep -q '"/internal' packages/contract/openapi.json \
            || { echo "/internal/fleet escaped into openapi.json"; exit 1; }
      - name: Gate — no Vietnamese diacritics in code or tests
        working-directory: testkite
        run: |
          if grep -rlP '[\x{00C0}-\x{1EF9}]' apps/*/src apps/*/test packages/*/src 2>/dev/null | grep -v fixture; then
            echo "Code and tests must be written in English (CLAUDE.md rule 4)"; exit 1
          fi
      - name: Gate — the API image contains no browser binary
        run: |
          ! grep -rq "playwright\|chromium" testkite/apps/core/package.json
```

- [ ] **Step 5: Verify toàn bộ + commit**

```bash
cd testkite && pnpm typecheck && pnpm lint && pnpm --filter @testkite/core test
eval "$(scripts/test-pg.sh start)" && pnpm --filter @testkite/core test; scripts/test-pg.sh stop
git add testkite .github/workflows/testkite-ci.yml
git commit -m "M3-ORC T15: wiring composition root (internal plane + dispatcher), fixture L3, gate CI"
```

---

## Task 16 — Tick backlog M3

- [ ] Trong `testkite/tasks/M3-orchestration-fleet.md`, tick các dòng thuộc **control plane** và ghi hash commit:
  - `- [x] job_runs = queue of record ... (hash: <T2>)`
  - `- [x] Dispatcher v1 FIFO ... (hash: <T7,T8>)`
  - `- [x] Internal HTTP plane /internal ... (hash: <T13>)` — phần `/fleet` của worker do plan fleet tick
  - `- [x] Presigned PUT cho artifact (control plane) (hash: <T12>)` — trace/screenshot ring-buffer do plan fleet
  - `- [x] Results 3 tầng + SSE run status (hash: <T11,T14>)`
  - Dòng "Worker (apps/runner)" tick MỘT NỬA: phần lease/epoch phía server đã xong (T5, T6), phần vòng lặp worker thuộc plan fleet.
- [ ] Commit: `M3-ORC T16: tick backlog M3 phan control plane`

---

## Self-Review

### 1. Spec coverage

| Yêu cầu (blueprint §4/§5 + backlog M3 + brief) | Task |
|---|---|
| `job_runs` = queue of record, `FOR UPDATE SKIP LOCKED` | T2 (schema, index), T5 (claim), T5 Step 5 (chứng minh disjoint trên PG thật) |
| status/lane/job_kind/lease_epoch/attempt + team_id dẫn đầu index + `UNIQUE(team_id,id)` + composite FK + RLS | T2 |
| Migration + GRANT viết tay theo pattern có sẵn | T1, T2, T3, T7, T9, T10, T11, T12 (mỗi task một cặp generate + grants) |
| Phase 0: nạp snapshot qua facade authoring, gọi `compileRun` pure | T4 |
| Lưu RunPlan bất biến + `content_hash` | T1 (append-only GRANT), T4 (ghi) |
| Tạo `job_runs` cho từng chain | T4 |
| Diagnostics ⇒ verdict `compile_error`, hoàn quota, KHÔNG browser | T3 (reserve/refund), T4 (test "creates NO job at all") |
| Dispatcher v1 FIFO, tick 250ms, fan-out 200/tick | T8 |
| Leader-elect qua cờ DB (spike chọn) | spike §3 + T7 (row-lock TTL, **quyết định + lý do**) |
| Dead-man alert khi leader chết | T7 (`readLease().stale`), T8 (`onDeadMan`) |
| Fair-share DRR để M5, ghi rõ ngoài phạm vi | T8 (mở đầu task) + mục "Ngoài phạm vi" dưới |
| Claim = conditional UPDATE bump `lease_epoch` | T5 |
| Heartbeat reap nghi 15s / chết 30s | T6 |
| Bump epoch + requeue ĐẦU hàng đợi team | T6 (+ spike §4 đo thứ tự thật) |
| Mọi mutation từ worker mang epoch; sai ⇒ 409 `STALE_EPOCH` | T13 (hợp đồng + contract test 4 endpoint × 6 kịch bản) |
| Internal plane `/internal/fleet`, worker zero-credential, token scope theo run | T9 (bootstrap→worker→run token), T13 (plane) |
| Đăng ký theo pattern descriptor + `config.tk` | T13 (`INTERNAL_ROUTES` + `config.tkInternal`, cùng cơ chế hook `onRequest` đọc descriptor như `installAuth` của M2) |
| Event từ worker idempotent theo seq | T10 |
| Contract test từng endpoint khẳng định thiếu/sai epoch bị từ chối | T13 Step 2 (bảng `MUTATIONS`) + T13 coverage gate |
| `res_case_results` / `res_step_results` + cột attempt + luật đọc `MAX(attempt)` | T11 |
| Partition tháng theo pattern `audit_events`, GRANT chỉ bảng cha | T11 (+ spike §7 đo lại bằng lệnh thật) |
| SSE run status | T14 (+ spike §8) |
| Presigned PUT: cấp URL có hạn + ghi metadata | T12 (+ spike §9 khớp test vector AWS) |
| Cross-tenant ⇒ 404 không bao giờ 403 | T1, T2, T4, T10, T11, T13, T15 (bộ L3 tự sinh) |
| AssertionFailure là verdict, không retry | T5 (test "never retries an assertion failure"), T13 (`complete` với `infra: null`) |
| Quarantine chain sau 2 OOM | T5 (`oom_count` + `quarantined_at`) |
| Khai rõ hợp đồng để plan fleet code theo + tranh chấp file | mục "Hợp đồng cho plan fleet" (endpoint, payload, luật epoch, mã lỗi, **5 chênh lệch** so với giả định của plan fleet, bảng tranh chấp file + quy trình sau rebase) |
| Ngôn ngữ: code/test tiếng Anh | mọi task; gate máy ở T15 Step 4 |
| DAG + ownership.json | orchestration↦`orc_`/`job_runs`, results↦`res_`, governance↦`usage_counters`; import chéo chỉ qua facade (T4 gọi authoring/governance/planning qua `index.ts`) |

### 2. Ngoài phạm vi CÓ CHỦ ĐÍCH (không phải thiếu sót)

- **Toàn bộ data plane**: worker loop, executor Playwright, memory governance L1–L3, cgroup lồng, recycle, `runnerd`, systemd unit, upload thật lên presigned URL, trace/screenshot ring-buffer NVMe → **plan `2026-08-29-m3-fleet.md`**.
- **Fair-share DRR + cost + cap/team + sàn chống đói 60s** → M5. Cột `job_runs.cost` đã có sẵn để M5 chỉ đổi `ORDER BY`, không migrate.
- **Phase 7.5 cổng health env** (probe base_url 3×/10s ⇒ verdict `blocked`) → M4, khi `pln_environments` có secret_refs + health probe thật. Enum `run_verdict` đã có `blocked`.
- **Breaker infra >10% + abort-sớm khi 25 chain đầu fail cùng signature** → M5 (cần dữ liệu lịch sử để đặt ngưỡng).
- **Work-stealing giữa lane, tenant-pinning batch, pre-warm interactive** → M5.
- **BullMQ**: relay của M1 vẫn là nơi duy nhất chạm BullMQ; queue thi hành test KHÔNG dùng BullMQ (queue-of-record là Postgres).
- **LISTEN/NOTIFY cho SSE** (đo 0.29–0.94ms) → M6, khi có nhiều instance API và số viewer đủ lớn để 1 query/giây/viewer thành vấn đề.
- **Retention `res_*` + `DETACH` hằng tháng** → M6 (hàm `ensure_result_partition` + `ensureResultPartitionsSql` đã sẵn sàng; spike đã ghi cảnh báo `DETACH CONCURRENTLY` không dùng được).
- **Live View `Page.startScreencast`** → P2 theo blueprint §5.1.

### 3. Placeholder scan

Không có "TBD" / "tương tự Task N" / "thêm xử lý lỗi phù hợp". Mọi step viết code đều có block code thật; mọi step chạy đều có lệnh + kết quả mong đợi. Bốn chỗ cố tình viết dạng khung có chú thích rõ nội dung phải điền (T6 Step 5, T11 read-rule, T12 artifacts, T13 Step 6, T14 run-routes) đều kèm bảng ràng buộc hoặc danh sách assertion cụ thể, không phải "viết test cho phần trên".

### 4. Type consistency

- `EpochOutcome<T>` khai ở T5 (4 nhánh miss: `not_found`/`cancelled`/`terminal`/`stale_epoch`), dùng nguyên tên ở T6 và T13 (`unwrap` ánh xạ 1-1 sang `NotFoundError`/`JobCancelledError`/`JobTerminalError`/`StaleEpochError`).
- `ClaimedJobRow` (T5) ↔ `claimedJobSchema` (T13): cùng field, khác ở `runToken` + `plan` + `leaseDeadlineAt` do handler `internalClaim` thêm sau khi mint token và đọc `orc_run_plans` — ghi rõ trong bảng ràng buộc handler.
- `RunEventKind` khai ở T10 (`RUN_EVENT_KINDS`) và `RUN_EVENT_KIND_VALUES` ở contract T13 — **cùng danh sách, hai nơi**: contract không được import `apps/core`, nên `internal-coverage.test.ts` có test khẳng định hai mảng bằng nhau (`expect([...RUN_EVENT_KIND_VALUES]).toEqual([...RUN_EVENT_KINDS])`).
- `CaseResultInput` / `StepResultInput` khai ở T11 (results) và mirror bằng zod ở T13 (`caseResultSchema`/`stepResultSchema`); handler `internalComplete` chuyển đổi một lần, không có kiểu thứ ba.
- Vị từ RLS `team_id = NULLIF(current_setting('app.team_id', true), '')::uuid` viết y hệt ở T1, T2, T3, T9, T10, T11.
- `withDispatchRole` khai ở T2, dùng ở T5, T6, T7, T9.
- `assertTenantContext` (M1) dùng lại ở T3, T4, T9, T10, T11.
- `DISPATCH_ROLE` (T2) là hằng compile-time duy nhất được nội suy vào `sql.raw` — cùng quy ước như `APP_ROLE`/`AUTH_ROLE` của M1/M2.

### 5. Rủi ro đã biết, đối sách nằm trong plan

| Rủi ro | Đối sách |
|---|---|
| Hai dispatcher cùng tin mình là leader (split-brain trong cửa sổ TTL) | Đúng đắn KHÔNG phụ thuộc leader: `dispatchPending` dùng SKIP LOCKED + conditional UPDATE (đo: hai dispatcher song song, 50 job, tổng đúng 50). Leader chỉ để reaper đơn luồng + tick đều. |
| `GRANT testkite_dispatch TO testkite_app` (vô tình, ví dụ khi dọn role) ⇒ `testkite_app` đọc mọi team | Đo được (spike §6). T2 có test đọc `pg_auth_members` khẳng định membership không tồn tại. |
| Reaper chạy hai bản ⇒ `MIN(queue_seq)-1` hoà giá trị ⇒ thứ tự bất định | Reaper chỉ chạy trong tick của leader; **và** khoá thứ tự đầy đủ `(priority DESC, queue_seq, id)` nên dù hoà vẫn tất định (T2, T6). |
| Partial index sai cột dẫn đầu ⇒ dispatcher chậm 49× khi backlog lớn | Đo được (spike §5). T2 có test đọc `pg_indexes` khẳng định đúng ba index, đúng thứ tự cột. |
| `GRANT` nhầm trên partition con ⇒ rò chéo tenant im lặng | Đo được (spike §7: thấy 3/3 row của hai team). T11 có test quét `information_schema.role_table_grants` bắt mọi GRANT trên bảng con. |
| Worker giữ token quá lâu sau khi mất lease | Run token TTL = `lease_expires_at + 60s`, **và** bị revoke ngay trong transaction của `complete`/reap (T9, T13). Test: sau requeue, gọi tiếp bằng token cũ ⇒ 401. |
| SSE rò timer + rò query mỗi giây khi tab bị bỏ | `req.raw.on("close")` dọn cả hai interval; test đếm `process.getActiveResourcesInfo()` (T14). |
| `pg.Client` sống lâu chết vì `Unhandled 'error' event` khi backend bị giết | Tái hiện được trong spike §12. Mọi client sống lâu bắt buộc `client.on("error", …)` — ghi trong T7/T8 và trong hợp đồng vận hành. |
| Chênh engine: PGlite 18.x (unit) / PG 16.13 (local) / PG 17 (CI, prod) | Test tranh chấp (T5, T6, T7) **chỉ** chạy trên Postgres thật; CI `postgres:17` là nguồn sự thật. PGlite không bao giờ được dùng cho tầng race. |
| Số thứ tự migration đụng nhau sau rebase | Tham chiếu bằng TAG; quy trình xoá-và-generate-lại ghi ở mục "Tranh chấp file". |
| `/internal/fleet` lọt ra openapi.json hoặc ra internet | Gate CI grep `openapi.json` (T15) + `INTERNAL_HOST` mặc định `127.0.0.1` + app Fastify riêng, port riêng. |
| Quota bị hoàn hai lần ⇒ đúc quota miễn phí | `GREATEST(used - n, 0)` + test riêng (T3). |
| Kết quả ghi được dưới epoch cũ (zombie ghi verdict) | `internalComplete` chạy `writeCaseResults` và `completeJob` trong **cùng transaction**: `completeJob` trả stale ⇒ ném lỗi ⇒ ROLLBACK, kết quả không tồn tại. Có test riêng khẳng định `caseResultCount === 0` sau một complete stale (T13 Step 2). |
