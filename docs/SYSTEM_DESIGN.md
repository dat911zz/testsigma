# Blueprint TestKite 🪁 — thiết kế hệ kiểm thử thay thế (path E)

> **Tên chính thức: TestKite** (chốt 27-08-2026, thay codename tạm SigmaNext). Tài liệu chị em của `docs/ARCHITECTURE_AUDIT.md` (nơi ghi các quyết định nền: vì sao rewrite lõi, census, phán quyết engine/container).

## Ý nghĩa tên

**TestKite = con diều.** Tên được chọn vì nó kể đúng câu chuyện kỹ thuật của hệ thống:

- **Diều = nhẹ** — linh hồn của fleet runner: sandbox nhẹ, container Playwright + chromium-headless-shell, sinh ra để chấm dứt lớp lỗi OOM của hệ cũ.
- **Sợi dây diều = control plane** — diều bay cao nhưng dây luôn nằm trong tay: PostgreSQL là queue + lease authority duy nhất, dispatcher giữ kiểm soát mọi con diều; đứt dây (host chết) thì bump epoch, requeue, không con diều nào ghi được verdict lậu (409 STALE_EPOCH).
- **Thả nhiều diều = spawn nhiều sandbox** — mỗi worker container là một con diều; muốn bay nhiều hơn thì thả thêm diều (thêm host), không phải làm một con diều to hơn.
- **Diều bay nhờ gió** — "làn gió mới" là lý do maintainer chọn rewrite ngay từ đầu.
- Thực dụng: dễ đọc cả tiếng Việt lẫn tiếng Anh, vibe thân thiện kiểu EasyTest nhưng không vô danh, không đụng thương hiệu QA nào (né hẳn `Sigma*`); tại thời điểm chọn tên, `testkite` và `kite-test` đều trống trên npm registry.

**Quy ước đặt tên đề xuất:** monorepo `testkite`; packages `@testkite/core`, `@testkite/runner`, `@testkite/verb-kit`, `@testkite/contract`, `@testkite/mcp`, `@testkite/ui`; daemon giám sát host giữ tên `runnerd` (hoặc `kited` nếu muốn chơi trọn bộ nhận diện).
> **Phương pháp:** workflow 9 agent / 4 pha — 3 trinh sát (domain từ schema thật + ngữ nghĩa runtime, migrate, pháp y OOM), 3 thiết kế (multitenancy, module lõi, fleet phân tán), 1 thẩm định 10 kịch bản nghiệp vụ, 1 critic (8 mâu thuẫn + 6 khoảng trống), 1 tổng kiến trúc sư chốt. Mọi claim then chốt xác minh trực tiếp trong source tại `a6155d0`.
> **Ngày:** 2026-08-27.

## Quyết định vòng hỏi-đáp trước spec (27-08-2026, maintainer chốt trực tiếp)

| # | Câu hỏi | Quyết định | Hệ quả thiết kế |
|---|---|---|---|
| 1 | Nhân sự | **+1 kỹ sư fleet — lịch 9 tháng** | 2 track song song: fleet (M3 phần runner) vs compiler/API |
| 2 | Hạ tầng | **Tự host / máy công ty** | Sizing theo Hetzner-class ~$350–450/th; trigger chi phí k8s gần như không bao giờ kích |
| 3 | Database | **PostgreSQL** (đổi so blueprint MySQL 8.4) | Drizzle driver pg; queue-of-record dùng `FOR UPDATE SKIP LOCKED` (pattern job-queue kinh điển của PG — tốt hơn bản MySQL); **RLS thành lớp cách ly L2.5** bổ sung composite-FK; partition declarative cho bảng result; importer từ dump MySQL cũ thành ETL cross-engine (map kiểu dữ liệu/collation — thêm ~1 tuần M7); docker-compose đổi postgres:17 |
| 4 | Số team go-live | **2–5 team ngay từ đầu** | M5 (fair-share + quota + onboarding) là GA-blocking đúng nghĩa; fleet khởi điểm 3 host; onboarding tested với ≥2 team thật trước cutover |
| 5 | App đích chịu tải | **Thoải mái (app prod hàng triệu user)** | Giữ nguyên sizing 24–66 context; yêu cầu còn lại: pool tài khoản test lease per-chain |
| 6 | Ngôn ngữ UI | **Song ngữ vi+en, i18n từ đầu** | +2–3 tuần setup i18n (M3–M4 phần UI); câu verb NLP giữ tiếng Anh khớp catalog, nhãn UI song ngữ |
| 7 | Auth | **SSO + email nội bộ** | Email/password + **generic OIDC connector**; IdP đã chốt 28-08-2026: **Keycloak self-host** (dev/test dùng mock OIDC in-process vì sandbox không Docker; CI cân nhắc Keycloak service container) |
| 8 | Retention | **Kết quả test VĨNH VIỄN; ảnh/artifact tối đa 30 ngày** | Đổi so blueprint (90d full): res_* rows giữ mãi → partition theo tháng bắt buộc từ v1 + rollup summaries; lifecycle object store: mọi ảnh/trace ≤30d (failure cũng vậy — `failure_context` JSON trong DB là bản ghi debug vĩnh viễn) |

## Tóm tắt điều hành

Monolith TypeScript 12 module trên DAG một chiều + **Run Compiler** sinh run-plan bất biến content-hashed + **fleet runner 2 mặt phẳng với 4 tầng trần bộ nhớ**. Tenant = team (org → team → project), cách ly 3 lớp độc lập. Stack: Node 22, Fastify 5 + zod (OpenAPI sinh từ zod, CI chặn drift), Drizzle + PostgreSQL 17, BullMQ 5 + Valkey, Playwright chromium-headless-shell, React 19 + Vite, Vitest (unit DB trên PGlite in-process; concurrency + CI trên Postgres 17 thật qua service container — Testcontainers loại vì môi trường dev không đảm bảo Docker daemon, xem spike trong plan m1-kernel-db).

**Công sức thật: ~15–18 tháng-người** (baseline 7–10 + multitenancy 3,0 + fairness/quota 1,5 + fleet hardening 2,5 + capture/cutover/DR từ kịch bản 2,25 + migrate 0,75 − cắt giảm 1,0). **9 tháng lịch nếu có thêm 1 kỹ sư lo fleet; ~12 tháng solo.** Quyết trước M1.

---

## 1. Pháp y OOM hệ cũ (đã xác minh trong code)

Xếp theo mức đóng góp:

1. **Chrome native chạy NGAY TRONG container API, không giới hạn số lượng.** `StandaloneAppBridge` đăng ký vô điều kiện lúc boot (`AppStartupRunner.java:33`) → mỗi plan chạy = `new TestPlanRunTask().start()` bare Thread (`AgentExecutionService.java:788`) → không có Grid thì `ChromeDriver.java:33-41` fork Chrome thật trong container API → scheduler 3 phút đổ mọi plan vào `Executors.newCachedThreadPool()` (`ScheduleExecutionTaskFactory.java:42`) — zero Semaphore/RateLimiter trong cả 2 module. Lịch dồn cụm = fan-out browser không trần.
2. **Bug "năm 3922":** `OldResultMigrationScheduler` dùng `new Timestamp(2022,10,8,…)` (years-since-1900 ⇒ năm 3922) → mốc cắt khớp mọi bản ghi vĩnh viễn; mỗi 3 phút re-scan toàn bộ step-result FOR_LOOP qua join 4 bảng `JSON_EXTRACT` không index được, đệ quy, N+1, không cờ hoàn thành. Tải tăng đơn điệu theo tuổi dữ liệu.
3. **Không trần nào tồn tại:** `start.sh:63` không `-Xmx`; compose không `mem_limit`; và heap cap không đủ vì Chrome native nằm ngoài JVM — OOM killer giết bừa (cả mysqld/nginx). Phụ: POI DOM-based + multipart 500MB, upload pool 100 thread, Hikari mặc định, open-in-view=true.

**Quyết định 27-08-2026 — KHÔNG vá hệ cũ (clean break):** maintainer chốt chuyển mới hoàn toàn, không bảo trì hệ gốc nữa — mọi hạng mục "stopgap tuần 1" (semaphore, tắt scheduler, mem cap) bị loại khỏi kế hoạch; pháp y OOM ở trên giữ lại làm *căn cứ thiết kế* cho fleet mới, không phải việc phải làm. Rủi ro nhận có chủ đích: hệ cũ giữ nguyên trạng (kể cả OOM) tới cutover; nếu nó sập không phục hồi trước khi migrate xong thì mất nguồn parallel-run. Bảo hiểm tối thiểu (bảo vệ **dữ liệu**, không phải bảo trì **hệ**): `mysqldump` tự động hằng đêm từ ngoài vào DB cũ — việc này nằm trong M7, không đụng code gốc.

**Hệ mới làm lớp lỗi này không-thể-viết-ra:** năng lực chạy = thuộc tính hạ tầng (M container × K context), admission ở Postgres trước khi BullMQ thấy job; API image không chứa browser (CI grep layer manifest); mọi job nền là one-shot có completion persist; CI từ chối manifest thiếu memory limit; soak T7 chạy đêm chứng minh lại liên tục.

## 2. Mô hình nghiệp vụ & migrate

**Hai khám phá nền tảng:**
- **Bí ẩn 7.344 suite/7.112 plan:** `DryTestPlansController.create()` đúc row "Dry run "+timestamp với discriminator `ADHOC_*` mỗi lần chạy nháp → là khí thải. Heuristic migrate: chỉ lấy `entity_type IS NULL OR IN ('TEST_SUITE','TEST_PLAN')` (+ loại phòng thủ tên `Dry run %`). Bộ thật dự kiến vài trăm.
- **Prereq không phải "chạy case này trước":** set prereq → hệ cũ *chèn vật lý* case login vào trước case phụ thuộc trong mọi suite chứa nó (`TestSuiteService.java:265`); suite chạy tuần tự trên MỘT session WebDriver liên tục nên cookie sống sang case sau; gate `checkTestCasePrerequisiteFailure` chỉ tra kết quả trong cùng suite-run. Hệ mới: prereq = primitive hạng nhất của **case chain** (đơn vị job), bỏ side-effect chèn suite. Chuỗi validate cycle-free, depth ≤ 5 (giữ luật cũ).

**Domain mới ~58 bảng, PostgreSQL** (prefix theo module; bảng tenant nào cũng có team_id dẫn đầu index + UNIQUE(team_id,id) + composite FK):
- Identity (hệ cũ KHÔNG có bảng user/role nào): organizations, teams, projects, users, memberships, api_tokens (hash + scope ∩ role mỗi request), mcp_clients, element_proposals.
- Governance: quota_limits (6 chỉ số), gov_quota_reservations, usage_ledger (append-only là sự thật, Redis hot path), audit_events (partition tháng, 400 ngày).
- Catalog: action_catalog toàn cục (35 active + 551 archived; op registry trong code — Class.forName chết), elm_screens/elm_elements (FK thật thay tên chuỗi; create_type; pending_locator), tdt_profiles/rows (giữ expected_to_fail).
- Authoring: aut_cases (giữ is_step_group một-bảng; đủ 5 timestamp workflow — vá dead-DTO cũ), aut_steps (36→27 cột: bỏ 6 addon_* + 3 for_loop_* vestigial — đã xác minh NULL; + subscription_id XOR step_group_case_id), aut_step_loops (for_step_conditions 1:1 — engine loop thật), aut_rest_steps, aut_case_revisions (snapshot zstd append-only), aut_tags (team-scoped).
- Planning: pln_suites/suite_cases (giữ position), pln_plans (thành run-config; ADHOC_* chết), pln_run_targets (test_devices tái sinh web-only — cột Appium chết), pln_environments (**project-scoped, base_url BẮT BUỘC**, secret_refs thay password inline), pln_schedules (BullMQ repeatable + jitter 0–15ph).
- Sharing: published_step_groups/versions (snapshot bất biến), step_group_subscriptions (ghim version — không bao giờ auto-advance).
- Orchestration: orc_runs, orc_run_plans (content_hash, zstd, planFormatVersion), **job_runs = queue-of-record + lease authority duy nhất (PG `FOR UPDATE SKIP LOCKED`)** (status, lane, job_kind, lease_owner/epoch/expires, attempt, consecutive_oom_count), orc_workers, egress_policies, migration_state, migration_parallel_runs.
- Results 5→3 tầng: job_runs → res_case_results (iteration nuốt bảng data-driven; attempt; **engine CHECK — chỉ engine có layout thật ghi verdict**) → res_step_results (+failure_context JSON ≤32KB). res_artifacts theo attempt; res_advisory_signals (không có cột verdict — structural).

**Trình tự migrate (offline; hệ cũ không bao giờ bị ghi):** tenancy trio → lookups + env (bóc base_url; không parse được → operator điền) → screens/elements/testdata → cases+steps+loops+rest (resolve tên element → FK; fail → pending_locator + report) → suites/plans qua heuristic → **results: 90 ngày full fidelity, cũ hơn → rollup; screenshot/trace cũ không copy** → schedules cuối. **Xác minh:** row-count invariant + **compile toàn bộ case migrate, yêu cầu zero ERROR** + diff 50 chain mẫu. **Cutover per-suite đảo ngược được (clean break — KHÔNG sửa code hệ cũ):** freeze bằng tầng DB — `REVOKE INSERT/UPDATE/DELETE` trên user MySQL của app cũ trong cửa sổ copy, mutation-count trước/sau chứng minh freeze giữ, xong thì GRANT lại → `migration_state old|parallel|new` (parallel = scheduler MỚI bắn cả 2 stack, hệ cũ chỉ bị *gọi* qua REST API sẵn có; differ `(case, step ordinal)→verdict` + lọc flake N=3) → flip; rollback = flip ngược. DB mới disposable tới khi suite đầu vào 'new'.

## 3. Multitenancy

- **Phân cấp:** organizations (1 row) → **teams = tenant** (cách ly, quota, RBAC, đơn vị fairness) → projects → tài sản. workspace_versions không port.
- **Cách ly 3 lớp (+L2.5 RLS của Postgres):** L1 repository base fail-closed đòi TenantContext (lint cấm query builder thô ngoài `modules/*/db/repo.ts`); L2 composite FK `(team_id, parent)` toàn đồ thị — ghi chéo tenant fail tại InnoDB; L3 bộ CI cross-tenant sinh từ OpenAPI: token team B + id team A ⇒ **404, không bao giờ 403**. Trigger xem lại T1–T5 có văn bản (T3: leak thật → đánh giá Postgres+RLS ngay).
- **RBAC 6 vai** (instance_operator, org_admin, team_admin, author, runner, viewer) — ma trận TS, không bảng grants; org_admin không đọc tài sản team mặc nhiên (break-glass audit HIGH); runner = trigger+read (CI không sửa được test); four-eyes = người-sửa-cuối-không-tự-promote. Token: 1 team, SHA-256, bắt buộc hạn, scope ∩ role mỗi request. Never-grantable: secret:write, quota:set, element:write (→ element:propose), token:issue:service, team:purge.
- **Quota 6 chỉ số, 5 điểm cưỡng chế** (enqueue 429 chỉ cho API/UI — fan-out schedule miễn, đậu ở MySQL; dispatch cap; metering 60s; pre-PUT artifact với trần 2GB/run + sampling theo failure-signature; pre-flight AI). Chạm trần: chặn cái mới, **run đang bay luôn chạy nốt**.
- **Chia sẻ:** element copy-on-share kèm provenance; step group publish/subscribe ghim version bất biến (frozen snapshot — zero đọc chéo lúc chạy); data/env/secret không bao giờ share. Onboarding 1 transaction idempotent (kèm seed egress allowlist từ base_url, observe 14 ngày). Offboarding: suspend → archive (≥30d, export) → purge (2 chữ ký, chặn khi còn subscriber).

## 4. Module lõi & Run Compiler

- **12 module DAG một chiều:** kernel → identity, governance → verbs | elements | testdata → authoring → planning → orchestration → results; edge: integrations, ai, mcp. Bảng thuộc đúng 1 module (ownership.json + eslint-boundaries + madge). Xuôi = facade call; ngược/ngang = **transactional outbox** → relay → BullMQ events → handler idempotent. **Worker không có credential DB** — HTTP plane nội bộ, token scope theo run.
- **Run Compiler (pure function, golden-tested, hash ổn định):** 0 admission/reserve (202 ngay) → 1 resolve chuỗi prereq (ghim revision: schedule/CI = bản 'ready'; ad-hoc author = 'latest') → 2 nở cấu trúc (step group inline ≤5, if/loop thành cây, data-driven fan-out + expected_to_fail) → 3 bind verb vào op registry (gom mọi lỗi) → 4 element → LocatorSet (pending_locator ⇒ diagnostic) → 5 data/env merge, secret = $secretRef → 6 stamp policy/tenant → 7 freeze (SHA-256, zstd, planFormatVersion; có ERROR ⇒ compile_error, trả quota) → 7.5 **cổng health env** (probe base_url 3×/10s; sập ⇒ blocked) → 8 dispatch → 9 thực thi, events seq-idempotent, failure_context ghi tại step fail.
- **Taxonomy lỗi:** AssertionFailure = verdict failed, không bao giờ retry; chỉ RetryableInfraError retry; app treo = failed(timeout). 3 phanh: cổng health, abort-sớm khi 25 chain đầu fail cùng signature, breaker infra >10%. Quarantine sau 2 OOM/chain.
- **Đồng thời:** case version + ETag/If-Match (428 nếu thiếu), 409 kèm diff 3 chiều; advisory lock hiện diện TTL 60s.
- **Testing 8 tầng (chống trớ trêu):** T1 compiler golden; T2 35 op × engine golden trên headless-shell thật; T3 contract + oasdiff + fuzz; **T4 bộ cách ly tenant — không thương lượng**; T5 Postgres thật — service container CI postgres:17 (outbox atomicity, fairness, lease, races; PGlite CẤM dùng cho tầng race — một connection nên contention là giả); T6 đúng 1 e2e smoke <5ph; **T7 soak đêm chống OOM tái sinh**; T8 compile-toàn-bộ khi migrate. Bỏ chủ đích: unit test component, coverage target, DB mock.
- **API:** ~58 endpoint /v1 + 6 endpoint /fleet nội bộ (epoch bắt buộc mọi mutation) + MCP tools (list/get/search, draft_case, trigger_run, get_run_status, get_failure_report, element:propose) đi chung authorize().

## 5. Fleet runner phân tán

- **2 mặt phẳng.** Control: Core API + dispatcher (leader, tick 250ms) + relay + **PostgreSQL (queue + lease duy nhất, SKIP LOCKED)** + Valkey (cache admitted — flush được) + MinIO. Data: N host, mỗi host: `ts-workers.slice` (MemoryHigh 80%/Max 88%) chứa `ts-worker@1..M` (container uid 10001, cap-drop ALL, seccomp userfaultfd-denied, read-only rootfs, shm 1g, swap off) + `runnerd` ~800 LOC TS (heartbeat 5s, PSI watermark, drain — chết cũng không ảnh hưởng data path). Host không mở cổng inbound; lệnh đi theo heartbeat response. **Sandbox Chromium BẬT** — không bao giờ --no-sandbox.
- **4 tầng trần bộ nhớ:** L0 slice host; L1 container 3GB (K=4; interactive 2GB K=2), pids 512, cpus 2.0; **L2 cgroup lồng cho browser: memory.max = container−400MB, oom_score_adj Node −500 / Chromium +500 — kernel giết đúng Chromium, Node SỐNG, đọc memory.events, quy tội context RSS cao nhất, tự báo infra-error{browser_oom, epoch}** — container tự chẩn đoán; L3 per-context 350MB soft/500MB hard poll 5s. Shedding 75/85/92%; watermark host GREEN/AMBER/RED theo PSI. Bán kính nổ = 1 container = 4 chain cùng tenant — không bao giờ API/MySQL/tenant khác. Trace buffer trên NVMe XFS quota 2GB/worker (không tmpfs — tmpfs tính vào memory cgroup). Recycle: context/chain; browser 50 context/45ph/1.4GB/crash; container 500 job/12h/rss-floor>130%.
- **Lease:** claim = conditional UPDATE bump lease_epoch (0 rows = bỏ); heartbeat reap (nghi 15s, chết 30s) → bump + requeue đầu hàng team; zombie ghi verdict = 409 STALE_EPOCH; đọc theo MAX(attempt), row attempt cũ giữ 7 ngày.
- **2 lane:** interactive = worker riêng pre-warm mỗi host, **miễn tenant-pinning** (context/chain, rủi ro chấp nhận cho std tier; tenant gắn cờ gvisor có pool riêng), SLO p95 chờ <3s / click-tới-step <5s; batch tenant-pinned khi giữ context; work-stealing chỉ khi interactive rỗng >120s.
- **Dispatcher (một spec duy nhất):** MySQL pending → deficit-weighted RR, cost = clamp(ceil(steps/10),1,8), cap/team = clamp(ceil(fleet×share×1.5),4,floor(fleet×0.5)), sàn chống đói 60s, fan-out 200/tick, dead-man alert + fallback FIFO 120s.
- **Hardening bậc thang:** tier 0 runc + egress default-deny per-tenant (netns → Envoy SNI, hard-deny RFC1918/169.254.169.254 — đóng lỗ SSRF cũ), DNS per-tenant, observe 14 ngày; tier 1 gVisor per-tenant flag (+15–30%); tier 2 Firecracker KHÔNG build — giữ interface SandboxProvider làm bảo hiểm (trigger F1–F4).
- **Sizing (tuyến tính theo giả định 75s/chain — CHƯA ĐO, pilot 200 chain bắt buộc trước khi mua máy):** 1 team: 2 host 8vCPU/24GB = 32+4 context, đêm ~1,7h (xấu nhất 4,9h), opex tổng ~$900–1.000/th cloud (~$350–450 Hetzner); 5 team: 3 host 16vCPU/32GB = 66 context — vẫn systemd; 20 team: k8s+KEDA (pre-warm cron 30ph + pre-pull image), ~200 context đỉnh, ~$2,4–2,8k/th. Thang: compose → systemd → k8s khi chạm 2/5 trigger (≥6 host; ≥8 tenant hardening phân hóa; peak:trough>4:1; residency; >$2,5k/th). Nomad: loại.
- **Observability tuần 1:** RSS/limit heatmap, oom_kills, **contexts_leaked (P1 >0 quá 5ph)**, rss_floor trend, PSI, **infra_error tách khỏi failed** (P1 >2%/30ph), queue_wait p95/tenant, tenant_starvation_seconds (P1 >120s), dispatcher dead-man, lease_stale_epoch_rejections.

### 5.1. Replay & Live View (bổ sung 27-08-2026 — hệ cũ không có cả hai)

Xác nhận từ audit: Testsigma cũ **không có** VNC/streaming/video/replay cho web run — chỉ screenshot từng step + UI polling; thứ "live" duy nhất là mirror màn hình *mobile* qua WebSocket agent local (phục vụ recorder). TestKite bổ sung cả hai với chi phí thấp vì đã đứng sẵn trên Playwright + CDP:

**Replay — gần như free, ship ngay v1:** Playwright **trace.zip** chính là time-travel replay xịn hơn video/VNC: DOM snapshot trước/sau từng action (inspect được element tại thời điểm fail), network, console, film strip screenshot. Thiết kế đã có trace-on-failure; bổ sung: (a) **hosted trace viewer** trên artifacts origin riêng (spec security đã có sẵn "sandboxed viewer" + signed URL 15 phút); (b) per-run flag `trace: 'always'` cho run debug/interactive (tính vào quota storage); (c) video webm (`recordVideo`) là flag optional, default off — kém giá trị hơn trace, chỉ hữu ích để share cho non-tech.

**Live View — P2, ~1–2 tuần, KHÔNG dùng VNC thật:** VNC đòi X server/Xvfb per container — nặng và sai kiến trúc với headless-shell. Thay bằng **CDP `Page.startScreencast`** (đúng cơ chế mobile-mirror cũ nhưng chuẩn hóa): chỉ bật khi có viewer thật (lazy — zero chi phí khi không ai xem), mặc định chỉ lane interactive; frame JPEG q~60, 5–10fps, ~300–800KB/s/viewer, đường đi: worker → internal events plane → SSE/WS → UI. Batch nightly không stream (không ai xem 2.000 chain lúc 3h sáng — trace là đủ); tùy chọn "peek" 1 frame/5s làm thumbnail tiến độ. **Security:** frame chứa dữ liệu app-under-test (cả giá trị đang gõ) → cùng chính sách secrets-grade như trace: origin riêng, signed URL ngắn hạn, không cache, mask field secret.

### 5.2. Screenshot từng step + nén tối đa (bổ sung 27-08-2026)

Giữ trải nghiệm "gallery ảnh từng step" của hệ cũ (thứ QA no-code nhìn hằng ngày) nhưng đảo ngược bài toán chi phí. Hệ cũ: PNG **full-page** (aShot stitch), mọi step, mọi run, upload qua pool 100 thread, giữ vô hạn → ~460GB/tháng nếu chạy đủ đêm. Bốn đòn bẩy, xếp theo sức nặng:

1. **Chụp đúng format ngay tại nguồn:** viewport-only (không full-page stitch), device-scale 1. v1: Playwright JPEG q70 (~30–70KB/ảnh); v1.1: **WebP q75 qua CDP `Page.captureScreenshot`** (CDP hỗ trợ webp, Playwright API thì chưa) — thêm ~25% nhỏ hơn JPEG. So PNG full-page ~250KB+ → **~7× nhỏ hơn** trước khi làm gì khác. KHÔNG re-encode AVIF trên worker (CPU 2 vCPU/container là của browser); nếu muốn AVIF thì làm ở cold job trên control plane.
2. **Dedup theo content-hash:** flow form-heavy có chuỗi step màn hình giống hệt nhau (click → gõ → gõ…) — SHA-256 bytes trùng ảnh trước ⇒ ghi row tham chiếu, không PUT object mới. Tiết kiệm thêm ~30–50%. Chỉ dedup exact-hash (near-dup perceptual = rủi ro mất bằng chứng thị giác).
3. **Chính sách theo lane (đòn lớn nhất):** interactive/debug = chụp mọi step (QA đang ngồi xem); batch nightly mặc định = **ring-buffer trên NVMe scratch của worker, chỉ upload khi chain FAIL** (cùng triết lý `retain-on-failure` của trace) — ảnh từng step vẫn đầy đủ cho mọi failure, còn 95–97% step xanh không tốn một PUT nào; chain xanh chỉ upload first+last làm bằng chứng chạy. Per-run override `screenshots: all|failure|none` — team muốn full gallery thì trả bằng quota storage của chính họ.
4. **Bundle + lifecycle:** batch mode đóng gói ảnh per-chain thành 1 tar + index JSON (1 PUT/chain ≈ 2.000/đêm thay vì 52.900 — trên S3 riêng phí PUT đã là ~$8/tháng nếu để rời); lifecycle S3/MinIO tự động: hot 7 ngày đầy đủ → warm 30 ngày giữ failure → cold theo `artifact_retention_days` của team. Không bao giờ base64 vào MySQL.

**Số liệu quy đổi (52.900 step/đêm):** kiểu cũ PNG-mọi-step ≈ 15GB/đêm ≈ **460GB/tháng**; TestKite mode `all` (WebP+dedup) ≈ 1,3GB/đêm ≈ **~38GB/tháng (~12× rẻ hơn)** — bật được nếu team thật sự muốn; mode mặc định `failure` (fail-rate 3–5%) ≈ **2–3GB/tháng**. Trace của failure vốn đã chứa film strip nên gallery step + trace bổ trợ nhau, không trùng chi phí đáng kể.

**Tầng nén sâu — chấp nhận UI lazy/hiển thị dần (bổ sung):** Lưu ý nền tảng: MinIO có nén transparent server-side nhưng dùng **S2 (họ Snappy), không phải zstd**, và mặc định **tự loại trừ ảnh** — nén lossless trên JPEG/WebP đã entropy-coded cho ~0%; "nén sâu" cho ảnh chỉ tồn tại trong miền codec (lossy). Bật MinIO compression chỉ cho object text (json/xml/log); zstd app-layer đã dùng cho run plan/revision. Bậc thang nén sâu cho ảnh, đổi bằng UX lazy:

1. **ThumbHash placeholder (~30 byte, lưu ngay trong row `res_step_results`)** — gallery render *tức thì* toàn placeholder mờ, ảnh thật lazy-load theo IntersectionObserver khi cuộn tới. Perceived speed còn nhanh hơn hệ cũ.
2. **Thumbnail 240px WebP (~2–4KB) cho gallery; ảnh full chỉ tải khi click.** 95% lượt xem gallery không bao giờ chạm ảnh full → băng thông đọc giảm ~10×.
3. **Cold-tier re-encode AVIF q45, max-width 1024** (one-shot job trên control plane khi ảnh chuyển warm→cold — không bao giờ trên worker): thêm 30–50% nhỏ hơn WebP. AVIF decode chậm hơn tí = đúng chỗ "show dần dần" chấp nhận được.
4. **(Nâng cao, optional cho mode `all`) đóng chuỗi screenshot per-chain thành video AV1/VP9 keyframe thưa:** các step liên tiếp gần giống nhau → inter-frame compression ăn sâu hơn dedup exact-hash nhiều (chuỗi 30 ảnh ~1MB WebP → ~100–300KB video); UI seek theo timestamp map step→frame. Đổi lại: seek chậm hơn, mapping phức tạp hơn — chỉ đáng khi có team bật `all` lâu dài.

Quy đổi sau tầng sâu: mode `failure` 2–3GB → **~1–1,5GB/tháng**; mode `all` 38GB → **~15–20GB (AVIF cold)** → **~5–8GB (video-pack)**. Thứ tự triển khai: (1)+(2) vào v1 UI (rẻ, thuần frontend+thumbnail job), (3) khi có lifecycle, (4) chỉ khi nhu cầu thật.

**"Lớp nén/giải nén trước MinIO" — quyết định: KHÔNG dựng proxy inline; nén ở hai đầu có sẵn.** Một proxy nén generic đứng giữa viewer↔MinIO sẽ: (a) thành điểm chết availability trên đường đọc artifact; (b) phá presigned-PUT flow và mô hình worker zero-credential; (c) tốn CPU control plane trên hot path; (d) với ảnh — 80–90% dung lượng — thì vô ích (tường entropy-coding). Thay vào đó:

- **Đầu ghi:** producer (worker/control plane) nén *trước khi PUT*. Object mà browser sẽ đọc trực tiếp → nén **brotli** và set metadata `Content-Encoding: br` + đúng `Content-Type` khi PUT: **browser tự giải nén native, UI không cần một dòng code nào** (zstd trong Content-Encoding: Chrome/Firefox đã hỗ trợ, Safari chưa → brotli là lựa chọn cross-browser). Object chỉ máy đọc (index bundle, log nội bộ) → zstd app-layer như run plan/revision đang làm.
- **Đầu đọc:** browser decode theo Content-Encoding; consumer máy (API/AI job) decode bằng thư viện. Không có thành phần mới nào ra đời.
- **Ngoại lệ có chủ đích:** tar bundle ảnh per-chain **giữ nguyên không nén** — ảnh bên trong đã nén sẵn (gain ≈ 0) và tar phẳng cho phép viewer lấy *một* ảnh bằng HTTP Range + index JSON; nén cả bundle sẽ mất khả năng range-read. Không double-compress (metadata `x-amz-meta-codec` đánh dấu); MinIO S2 compression chỉ bật cho content-type text và tự skip phần còn lại.
- **Kỳ vọng thật thà:** lớp này tiết kiệm thêm ~5–10% tổng dung lượng (phần text), vì ảnh/trace — chiếm đa số — đã nén trong miền codec. "Lớp nén đúng nghĩa" duy nhất đáng có là **transcode job codec-aware** (thumbnail/AVIF cold) đã thiết kế ở trên — async, ngoài hot path.

## 6. 10 kịch bản nghiệp vụ — kết quả thẩm định

7/10 lộ GAP vòng đầu, toàn bộ đã vá thành hạng mục build bắt buộc: S1 authoring → **element capture service** (micro-job Playwright+CDP stream ứng viên locator có chấm điểm + endpoint verify — hệ cũ có 13 controller recorder, không thể giảm element thành CRUD gõ tay); S3 → cổng health + abort-sớm theo failure signature; S4 → AI apply có stage resolve element (reference lạ → pending_locator chặn promote); S5 → element:write never-grantable → element:propose + failure_context có schema cho LLM; S6 → concurrency_group supersession; S7 → cỗ máy cutover per-suite; S8 → egress seed trong transaction onboard; S10 → runbook DR đầy đủ (RPO≤5ph/RTO 4h, quarantine job đang bay thành `unknown_after_restore` TRƯỚC khi reaper chạy, flush Valkey, reconciler artifact 2 chiều, recount quota, drill mỗi quý). S2/S9 PASS từ đầu.

## 7. Lộ trình 9 tháng (với kỹ sư fleet; solo giãn M3–M6 → ~12 tháng)

- **M1:** kernel, contracts, **compiler core + golden (xây ĐẦU TIÊN)**, schema tenancy. (Hệ cũ: clean break — không vá gì, xem §1.)
- **M2:** identity/RBAC/audit/token + CI cách ly; authoring + revision/review.
- **M3:** queue Postgres (SKIP LOCKED), dispatcher FIFO, worker + memory governance L1–L3 + lease, fleet systemd 2 host, results 3 tầng + SSE. *(4 tuần đầu track fleet = xóa sổ lớp lỗi OOM.)*
- **M4:** elements + capture + verify; 35 op + engine golden; testdata; planning (base_url, cổng health, schedule + jitter).
- **M5:** quota/metering, fair-share ON, lanes + supersession; AI drafts bind element; MCP.
- **M6:** webhooks, egress observe, dashboard/alert, DR + **diễn tập restore đầu tiên**, soak T7 chạy đêm.
- **M7:** script migrate + cổng T8 compile-all; migrate lookup/element/data/case; freeze + parallel-run + differ.
- **M8:** suite vào 'parallel' theo đợt, đốt diff, flip các suite đầu.
- **M9:** cutover trọn (suite khủng đi cuối), hệ cũ read-only, egress enforce, gVisor cho tenant cờ, buffer.
- **Sau GA:** admin UI (P3 ~1,5 pm) trước team 3–4; k8s theo trigger; decommission hệ cũ +30 ngày.

## 8. Câu hỏi mở (cần maintainer chốt)

1. Chạy `SELECT entity_type, COUNT(*) FROM test_plans GROUP BY entity_type` (+ bản test_suites) trên production — chốt bộ suite/plan thật.
2. Chính sách lịch sử: 90 ngày full + rollup — xác nhận.
3. **75s/chain chưa đo** — pilot 200 chain trước khi mua máy.
4. Mobile native vĩnh viễn ngoài scope — xác nhận trước khi schema ship.
5. Cloud vs tự host (~6× rẻ) — trước M3.
6. **Nhân sự: +1 kỹ sư fleet (9 tháng) hay solo (~12 tháng)** — trước M1.
7. Trần ngân sách AI/tháng lúc go-live.
8. Chính sách quản trị catalog step-group công bố — trước khi team 2 subscribe.
9. `test_devices.prerequisite_test_devices_id` bỏ không migrate — audit xác nhận không plan nào dùng.
10. UI cũ có từng surface review workflow không (review_submitted_at chưa từng persist) — chỉ ảnh hưởng truyền thông rollout.
