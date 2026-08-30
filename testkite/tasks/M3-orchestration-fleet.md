# M3 — Orchestration + Fleet (4 tuần đầu của track này = xóa sổ lớp lỗi OOM)

> Căn cứ: blueprint §5 (fleet 2 mặt phẳng, 4 tầng trần bộ nhớ, lease Postgres duy nhất).
> Track fleet chạy song song với M2 nếu có kỹ sư thứ hai.

## Checklist

> Nửa **control plane** đã xong theo plan `plans/2026-08-29-m3-orchestration.md` (T1–T16) — các dòng
> có hash bên dưới là của đợt đó. Dòng còn `[ ]` thuộc **data plane** (worker loop, memory governance,
> executor, systemd, soak) do plan `plans/2026-08-29-m3-fleet.md` thực hiện và tự tick.

- [x] `job_runs` = queue of record trên Postgres — claim bằng `FOR UPDATE SKIP LOCKED` (status/lane/job_kind/lease_epoch/attempt) + migration (hash: 53c51ad, 9e33aa1)
- [x] Dispatcher v1 **FIFO** (leader-elect qua cờ, tick 250ms, fan-out 200/tick, dead-man alert)
      — fair-share DRR để M5 (leader-elect = row-lock TTL trên `orc_dispatcher_lease`)
      (hash: 7b93cdd, 93513bb, 8b08b68, 9450927)
- [ ] Worker (`apps/runner`): claim = conditional UPDATE bump `lease_epoch` (0 rows = bỏ);
      heartbeat reap (nghi 15s/chết 30s) → bump + requeue đầu hàng team; 409 STALE_EPOCH test
  - [x] Nửa server: `claimNextJob` conditional UPDATE bump `lease_epoch` (0 row ⇒ bỏ), reaper nghi 15s /
        chết 30s → bump epoch + requeue ĐẦU hàng đợi team, mọi mutation sai epoch ⇒ 409 `STALE_EPOCH`
        (hash: 9e33aa1, 23d5378, 062aad2, 45df510)
  - [ ] Nửa vòng lặp worker trong `apps/runner` (register → claim → heartbeat → complete) — plan fleet
- [ ] **Memory governance L1–L3** theo `memory-governance.ts`: container limit, cgroup lồng browser
      (memory.max = container−400MB, oom_score_adj node −500 / chromium +500), per-context 350/500MB
      poll 5s, shed 75/85/92%, recycle, đọc `memory.events` tự báo `browser_oom`
- [ ] Quarantine chain sau 2 OOM + breaker khi fleet ốm; poison-chain alert
- [ ] Executor: chạy RunPlan trên Playwright chromium-headless-shell — 1 context/chain, đóng trong
      `finally`; AssertionFailure ⇒ verdict failed (KHÔNG retry); timeout lồng action<nav<step<chain
- [x] Internal HTTP plane `/internal` + `/fleet`: worker zero-credential, token scope theo run,
      epoch BẮT BUỘC mọi mutation (contract test từng endpoint); events báo kết quả idempotent theo seq
      — phía server (7 endpoint, app Fastify + cổng riêng); phía client trong worker do plan fleet tick
      (hash: cec366d, b873258, 096da8e, 45df510, cfca282, 9450927)
- [x] Presigned PUT cho artifact (control plane: cấp URL có hạn bằng `node:crypto` + ghi metadata
      `res_artifacts`) (hash: 746ed0a)
  - [ ] trace retain-on-failure; screenshot ring-buffer NVMe (blueprint §5.2) — plan fleet
- [ ] Fleet systemd 2 host: `ts-workers.slice` (MemoryHigh 80%/Max 88%) + `ts-worker@` template
      (Restart=always, OOMPolicy=continue) + `runnerd` (~800 LOC: register/heartbeat/PSI/drain)
- [x] Results 3 tầng (`res_case_results`/`res_step_results` + attempt + MAX(attempt) read rule)
      + SSE run status (hash: c6a565e, 91ce28d, c71bfa7, 80c47fc)
- [ ] CI gate: **API image không chứa browser binary** (grep layer manifest);
      manifest thiếu memory limit = fail
- [ ] Soak thử: 200 chain synthetic, RSS ceilings giữ, không orphan chromium, API RSS phẳng

## Exit criteria

- Giết -9 một worker giữa chừng: chain requeue đúng 1 lần, zombie bị 409, kết quả đọc MAX(attempt).
- Ép một chain ăn RAM vô hạn: kernel giết đúng Chromium, node báo `browser_oom` kèm peakRss,
  container khác + API không hề hấn.
- 24 context song song chạy hết đêm synthetic không OOM host.
