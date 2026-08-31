# M3 — Orchestration + Fleet (4 tuần đầu của track này = xóa sổ lớp lỗi OOM)

> Căn cứ: blueprint §5 (fleet 2 mặt phẳng, 4 tầng trần bộ nhớ, lease Postgres duy nhất).
> Track fleet chạy song song với M2 nếu có kỹ sư thứ hai.

## Checklist

> Nửa **control plane** đã xong theo plan `plans/2026-08-29-m3-orchestration.md` (T1–T16); nửa
> **data plane** (worker loop, memory governance, executor, systemd, soak) đã xong theo plan
> `plans/2026-08-29-m3-fleet.md` (T1–T20). Mỗi dòng ghi hash của đợt đã làm nó; dòng nào hai plan
> cùng đụng thì tách checkbox con để không ai nhận công của ai.

- [x] `job_runs` = queue of record trên Postgres — claim bằng `FOR UPDATE SKIP LOCKED` (status/lane/job_kind/lease_epoch/attempt) + migration (hash: 53c51ad, 9e33aa1)
- [x] Dispatcher v1 **FIFO** (leader-elect qua cờ, tick 250ms, fan-out 200/tick, dead-man alert)
      — fair-share DRR để M5 (leader-elect = row-lock TTL trên `orc_dispatcher_lease`)
      (hash: 7b93cdd, 93513bb, 8b08b68, 9450927)
- [x] Worker (`apps/runner`): claim = conditional UPDATE bump `lease_epoch` (0 rows = bỏ);
      heartbeat reap (nghi 15s/chết 30s) → bump + requeue đầu hàng team; 409 STALE_EPOCH test
  - [x] Nửa server: `claimNextJob` conditional UPDATE bump `lease_epoch` (0 row ⇒ bỏ), reaper nghi 15s /
        chết 30s → bump epoch + requeue ĐẦU hàng đợi team, mọi mutation sai epoch ⇒ 409 `STALE_EPOCH`
        (hash: 9e33aa1, 23d5378, 062aad2, 45df510) — plan orchestration
  - [x] Nửa vòng lặp worker trong `apps/runner` (register → claim → heartbeat → complete): client
        `/internal/fleet` zero-credential (bootstrap `tkb_` → worker `tkw_` → run `tkr_`, epoch bắt
        buộc mọi mutation, 409 ⇒ `StaleEpochError` KHÔNG retry) + vòng lặp shed-TRƯỚC-claim và
        zombie tự sát (dừng ngay, không complete/fail/upload gì)
        (hash: 4c12a1a, 96a38ab, ddbd685 — T15, T16) — plan fleet
- [x] **Memory governance L1–L3** theo `memory-governance.ts`: container limit, cgroup lồng browser
      (memory.max = container−400MB, oom_score_adj node −500 / chromium +500), per-context 350/500MB
      poll 5s, shed 75/85/92%, recycle, đọc `memory.events` tự báo `browser_oom`
      (hash: 0aaedb7, 46a9637, 8f6a702, ead5e4e, ab45211 — T3–T7)
      · Ranh giới: CI chứng minh LOGIC (cgroup fake, fixture chuỗi `memory.events`/PSI thật, quy tội
        RSS theo diff pid renderer). Việc kernel THẬT áp `memory.max` và giết đúng chromium chỉ
        nghiệm thu ở `test:host` (`test/host/cgroup-v2.test.ts`); `oom_score_adj −500` cần
        CAP_SYS_RESOURCE nên có thể trả `"denied"` và code phải nói to điều đó.
- [x] Quarantine chain sau 2 OOM + breaker khi fleet ốm; poison-chain alert (hash: d06ae16 — T8)
- [x] Executor: chạy RunPlan trên Playwright chromium-headless-shell — 1 context/chain, đóng trong
      `finally`; AssertionFailure ⇒ verdict failed (KHÔNG retry); timeout lồng action<nav<step<chain
      (hash: cf83bd5, f37c0c6, 5a2816e, be6cfd0, db82d95, 1eb21bd — T9–T12)
      · `finally { close() }` là bắt buộc vì `Promise.race` KHÔNG huỷ được action Playwright — chỉ
        `context.close()` mới huỷ (2 test riêng: throw và timeout).
- [x] Internal HTTP plane `/internal` + `/fleet`: worker zero-credential, token scope theo run,
      epoch BẮT BUỘC mọi mutation (contract test từng endpoint); events báo kết quả idempotent theo seq
      — phía server (7 endpoint, app Fastify + cổng riêng) (hash: cec366d, b873258, 096da8e, 45df510,
      cfca282, 9450927) — plan orchestration
  - [x] Phía client trong worker, import thẳng `@testkite/contract` (`INTERNAL_ROUTES` + schema hợp
        đồng, không tự khai lại) (hash: 4c12a1a, 96a38ab — T15) — plan fleet
- [x] Presigned PUT cho artifact (control plane: cấp URL có hạn bằng `node:crypto` + ghi metadata
      `res_artifacts`) (hash: 746ed0a)
  - [x] trace retain-on-failure; screenshot ring-buffer NVMe (blueprint §5.2): ring trên scratch +
        dedup theo content-hash SHA-256, WebP q70 qua CDP (Playwright API không hỗ trợ WebP),
        uploader zero-credential chỉ PUT vào URL do control plane ký
        (hash: 86c102e, ef92e9b — T13, T14) — plan fleet
- [x] Fleet systemd 2 host: `ts-workers.slice` (MemoryHigh 80%/Max 88%) + `ts-worker@` template
      (Restart=always, OOMPolicy=continue) + `runnerd` (~800 LOC: register/heartbeat/PSI/drain)
      (hash: 5dcd71d, c469779, 142d8fa — T17, T18)
      · Ranh giới: CI chứng minh unit PARSE được + deploy tree khớp hằng số `memory-governance.ts`.
        Việc systemd ÁP được directive chỉ nghiệm thu trên host pilot — sandbox không chạy systemd
        (PID 1 = `process_api`).
- [x] Results 3 tầng (`res_case_results`/`res_step_results` + attempt + MAX(attempt) read rule)
      + SSE run status (hash: c6a565e, 91ce28d, c71bfa7, 80c47fc)
- [x] CI gate: **API image không chứa browser binary** (grep layer manifest);
      manifest thiếu memory limit = fail
  - [x] Phần fleet: `playwright only in the runner image` (neo vào câu lệnh import THẬT — grep tên
        trần luôn đỏ vì comment TODO ở verb-kit — và khẳng định `apps/runner` PHẢI có
        `playwright-core`); mọi lane trong `runner-manifest.json` khai `memoryMb > 0` + `swap=false`;
        cú pháp unit systemd bắt lỗi theo OUTPUT vì `systemd-analyze verify` trả **exit 0** kể cả khi
        in `Invalid memory limit` / `Unknown key name` (hash: 142d8fa — T18) — plan fleet
  - [x] Phần control plane (plan `plans/2026-08-29-m3-orchestration.md` chịu): gate `apps/core`
        browser-free (grep module specifier + `apps/core/package.json`) và gate `/internal` không rò
        vào OpenAPI công khai (hash: c11c437, 9450927)
- [x] Soak thử: 200 chain synthetic, RSS ceilings giữ, không orphan chromium, API RSS phẳng
      (hash: 0360993 — T19; job CI `fleet-soak` chạy nightly 02:00 UTC, số đo ở "Exit criteria")

## Exit criteria

- Giết -9 một worker giữa chừng: chain requeue đúng 1 lần, zombie bị 409, kết quả đọc MAX(attempt).
- Ép một chain ăn RAM vô hạn: kernel giết đúng Chromium, node báo `browser_oom` kèm peakRss,
  container khác + API không hề hấn.
- 24 context song song chạy hết đêm synthetic không OOM host.

### Bằng chứng đã đo — soak 200 chain (T19, hash 0360993, 31-08-2026)

Hình thái chạy: chromium-headless-shell THẬT + `Worker` thật + `FakeControlPlane` nói đúng hợp đồng
đã chốt qua socket thật. Mỗi chain đi trọn đường production: claim → fence `chain_started` → 1
context → 8 step (WebP q70 qua CDP vào ring trên scratch) → trace retain-on-failure → `complete`.
Browser bị recycle THẬT theo `browserRecycleReason` 4 lần trong 200 chain, nên khẳng định "0 orphan"
đứng trước 5 lần chromium chết chứ không phải 1.

```
SOAK REPORT {"chains":200,"nodeRssBootBytes":123645952,"nodeRssStartBytes":153493504,"nodeRssEndBytes":161300480,"nodeRssFinalBytes":161488896,"browserTreeRssPeakBytes":240046080,"orphanChromiumAfter":0,"contextsLeaked":0,"msPerChainP50":877,"recycles":4}
```

Đọc: sàn RSS node 153,5MB → 161,3MB = **105,1%** (trần `MEMORY.recycle.containerRssFloorGrowthPct`
= 130%); đỉnh cây chromium 240,0MB (trần L1 batch 3072MB); **0 orphan chromium** đo SAU settle 1,5s
(đo ngay lập tức cho ra 2 process ⇒ ĐỎ GIẢ); **0 context rò** trên cả 200 chain; 877ms/chain, tổng
178,7s. Ba lần chạy 200 chain liên tiếp: 105,5% / 105,1% / 103% — số lặp lại được.

Soak này TÌM RA MỘT RÒ BỘ NHỚ THẬT và nó đã được sửa trong cùng commit: timer thua cuộc của
`Promise.race` không bao giờ `clearTimeout` giữ nguyên một `RunPlan` đã parse mỗi chain (0,55MB/chain).
Sửa bằng `raceDeadline()` trong `executor/timeouts.ts` (clear trong `finally`).

**Ranh giới của bằng chứng này — đọc TRƯỚC khi trích dẫn nó cho một tiêu chí nghiệm thu:**

- **Không** chứng minh sandbox chromium. Box chạy root, chromium từ chối bật sandbox ⇒ mọi số trên
  là số KHÔNG sandbox. Hình thái production (uid 10001, sandbox bật) chỉ nghiệm thu ở `test:host`
  (`test/host/chromium-sandbox.test.ts`) và ở job nightly trên runner GitHub (non-root).
- **Không** chứng minh tiêu chí #2. Soak không áp trần cgroup nào (sandbox cgroup v1 hybrid, không
  CAP_SYS_RESOURCE); "kernel giết đúng Chromium, node sống mà báo `browser_oom`" còn nợ host pilot
  (`test/host/cgroup-v2.test.ts`).
- **Không** chứng minh tiêu chí #1. Reap lease, `FOR UPDATE SKIP LOCKED`, TTL run token và presigned
  PUT THẬT là suite của `apps/core` + pilot end-to-end; `FakeControlPlane` chỉ chứng minh worker NÓI
  ĐÚNG hợp đồng (nó validate mọi request bằng chính schema của `@testkite/contract`).
- **Chỉ một nửa** tiêu chí #3. Soak chạy 200 chain TUẦN TỰ, 1 context/chain — nó đóng phần "không rò,
  không orphan qua nhiều lần recycle"; phần "24 context SONG SONG suốt đêm trên host" còn nợ pilot.
- "API RSS phẳng" **không** do soak đo: `apps/core` không tham gia soak. Nó phẳng vì ảnh API không
  bao giờ chứa browser — điều được giữ bằng gate CI browser-free, không phải bằng phép đo này.
- `msPerChainP50` chỉ để theo dõi XU HƯỚNG (box 4 vCPU dùng chung), **không** phải số capacity fleet.
