# M6 — Webhooks · Egress observe · Observability · DR

> Căn cứ: blueprint quyết định webhook 1 scheme, §5 observability tuần-1, S10 DR runbook.

- [ ] Webhooks: X-TS-Signature t=..,v1=HMAC-SHA256("<t>.<body>"), X-TS-Event/X-TS-Delivery (ULID),
      reject |now−t|>300s; itg_deliveries + retry backoff
- [ ] Egress per-tenant: netns → Envoy SNI allowlist, hard-deny RFC1918/169.254.169.254;
      observe-mode log (chưa enforce), seed từ base_url lúc onboard
- [ ] Observability: RSS/limit heatmap, oom_kills, **contexts_leaked (P1 >0 quá 5ph)**,
      infra_error tách failed (P1 >2%/30ph), queue_wait p95/tenant, tenant_starvation (P1 >120s),
      dispatcher dead-man, lease_stale_epoch_rejections; pino + OTel + Prometheus + dashboard
- [ ] **DR**: backup MySQL RPO≤5ph (snapshot đêm + binlog), runbook restore THEO THỨ TỰ:
      restore → quarantine job đang bay = unknown_after_restore (TRƯỚC khi reaper/dispatcher chạy)
      → FLUSH Valkey → reconciler artifact 2 chiều (orphan → quarantine 30d; dangling row → 410)
      → recount quota từ bucket → audit gap-marker
- [ ] **Diễn tập restore ĐẦU TIÊN** có bấm giờ (mục tiêu RTO 4h); lịch drill mỗi quý
- [ ] Soak T7 bắt đầu chạy đêm: 200 chain, RSS ceilings, orphan check, API RSS phẳng,
      admitted depth ≤ trần

**Exit:** drill restore đạt RTO; soak T7 xanh 7 đêm liên tiếp; alert nổ đúng khi tiêm lỗi thử.
