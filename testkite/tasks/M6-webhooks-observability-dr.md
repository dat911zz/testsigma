# M6 — Webhooks · Egress observe · Observability · DR

> Căn cứ: blueprint quyết định webhook 1 scheme, §5 observability tuần-1, S10 DR runbook.

- [ ] Webhooks: X-TS-Signature t=..,v1=HMAC-SHA256("<t>.<body>"), X-TS-Event/X-TS-Delivery (ULID),
      reject |now−t|>300s; itg_deliveries + retry backoff
- [ ] Egress per-tenant: netns → Envoy SNI allowlist, hard-deny RFC1918/169.254.169.254;
      observe-mode log (chưa enforce), seed từ base_url lúc onboard
- [ ] Observability: RSS/limit heatmap, oom_kills, **contexts_leaked (P1 >0 quá 5ph)**,
      infra_error tách failed (P1 >2%/30ph), queue_wait p95/tenant, tenant_starvation (P1 >120s),
      dispatcher dead-man, lease_stale_epoch_rejections; pino + OTel + Prometheus + dashboard
- [ ] **Nén run plan (zstd) ở tầng storage/transport** — nợ nhận về từ nhãn `TODO(M2)` mồ côi trong
      `packages/run-compiler/src/phase67-freeze.ts` (M2 đã 🟢 mà việc chưa hề làm; nay là
      `TODO(M6-storage)`). Compiler PURE nên KHÔNG nén: giữ `PLAN_FORMAT_VERSION = 1` = payload
      canonical THÔ. Nén thuộc orchestration lúc ghi `orc_run_plans` / truyền cho worker. Ràng buộc:
      nén ĐÚNG chuỗi canonical mà `contentHash` đã băm (không re-serialize, không sắp lại khoá) —
      sai điểm này là `contentHash` đổi nghĩa; đổi scheme nén ⇒ **bump `planFormatVersion` lên 2**
      và đường đọc phải giải được cả version 1
- [ ] **DR**: backup PostgreSQL **RPO≤5ph** = base backup (`pg_basebackup` hoặc snapshot volume) +
      **WAL archiving liên tục** (`archive_command` / `pg_receivewal`) ⇒ PITR tới từng giao dịch.
      `pg_dump` một mình KHÔNG đạt RPO≤5ph — nó là ảnh chụp LOGIC tại một thời điểm, mất trắng mọi
      thứ ghi sau lần dump cuối (dump đêm ⇒ RPO 24h); giữ `pg_dump` làm bản export kiểm chứng/di
      chuyển, không phải làm DR. Runbook restore THEO THỨ TỰ:
      restore → quarantine job đang bay = unknown_after_restore (TRƯỚC khi reaper/dispatcher chạy)
      → FLUSH Valkey → reconciler artifact 2 chiều (orphan → quarantine 30d; dangling row → 410)
      → recount quota từ bucket → audit gap-marker
- [ ] **Diễn tập restore ĐẦU TIÊN** có bấm giờ (mục tiêu RTO 4h); lịch drill mỗi quý
- [ ] Soak T7 bắt đầu chạy đêm: 200 chain, RSS ceilings, orphan check, API RSS phẳng,
      admitted depth ≤ trần

**Exit:** drill restore đạt RTO; soak T7 xanh 7 đêm liên tiếp; alert nổ đúng khi tiêm lỗi thử.
