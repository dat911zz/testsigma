# M0 — Vá hệ cũ sống khỏe 6–9 tháng (tuần 1, TRƯỚC mọi thứ)

> Hệ cũ là fallback + nguồn parallel-run của toàn chương trình. Nó đang OOM thường xuyên
> và mang bom vendor. Mọi mục ở đây là commit nhỏ, revert được từng cái.
> Căn cứ: `docs/SYSTEM_DESIGN.md` §1 (pháp y OOM) + `docs/ARCHITECTURE_AUDIT.md` mục 2, 8.2.

## Chống OOM (nguyên nhân đã xác minh trong code)

- [ ] **Semaphore 2–4 slot** chặn tạo `TestPlanRunTask` tại `pushEnvironmentToLab`
      (`AgentExecutionService.java:788`) — đòn bẩy cao nhất; size ≈ RAM host / 1GB-mỗi-Chrome
- [ ] Thay `Executors.newCachedThreadPool()` (`ScheduleExecutionTaskFactory.java:42`) bằng fixed pool nhỏ
- [ ] **Tắt hẳn `OldResultMigrationScheduler`** — bug `new Timestamp(2022,10,8,…)` = năm 3922,
      re-scan toàn bộ lịch sử mỗi 3 phút vĩnh viễn
- [ ] Short-circuit `TestDataMigrationScheduler` (thêm cờ hoàn thành persist)
- [ ] JVM flags trong `start.sh`: `-XX:MaxRAMPercentage=50 -XX:+ExitOnOutOfMemoryError`
- [ ] `mem_limit` tường minh trong docker-compose (heap + maxChrome×1GB + headroom)
- [ ] (Nếu thuận) trỏ `remoteServerURL` sang container `selenium/standalone-chrome` riêng —
      browser rời container API mà chưa cần rewrite
- [ ] Hygiene: cap upload pool 100→10 thread; `open-in-view=false`; Hikari tường minh;
      hạ multipart 500MB→50MB

## Tháo bom vendor (fallback chỉ tồn tại nếu bom đã tháo)

- [ ] **Mirror bucket `s3://hybrid-staging.testsigma.com` (~4,5GB)** về storage tự chủ —
      còn sống (HTTP 200 ẩn danh, verify 27-08-2026) nhưng là bucket staging của bên thứ ba
- [ ] Agent cert: self-signed + cache đĩa, **xóa `Runtime.exit(-1)`** (`AgentWebServer.java:58`);
      verify agent boot với domain vendor bị chặn trong `/etc/hosts`
- [ ] Xóa telemetry `TestsigmaOsStatsService` + 11 listener (đồng bộ, timeout 2–10 phút, không tắt được)
- [ ] Cờ `vendor.cloud.enabled=false` chặn ~19 điểm gọi os-services còn lại
- [ ] `mysqldump` + **diễn tập restore thật** vào instance scratch; tag baseline
- [ ] Xoay secrets: `admin@sample.com/admin`, `root/root`, Google OAuth secret;
      purge key DigiCert khỏi git history (`run-and-debug/nginx/ssl/`)

## Exit criteria

- Một tuần không OOM ở tải bình thường; dashboard RAM host có trần rõ.
- Agent boot được khi mọi domain vendor chết.
- Restore drill thành công có ghi lại thời gian.
