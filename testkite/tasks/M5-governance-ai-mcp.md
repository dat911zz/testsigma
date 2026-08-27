# M5 — Quota/Fair-share · AI drafts · MCP

> Căn cứ: blueprint §3 (quota 6 chỉ số, 5 điểm cưỡng chế), §9.6 đường D (AI 3 tầng), S4/S5.

- [ ] quota_limits + usage_ledger (append-only là sự thật; Redis hot path, reconcile giờ)
      + org-ceiling invariant trong 1 transaction FOR UPDATE + nightly invariant job
- [ ] 5 điểm cưỡng chế: enqueue 429 (chỉ API/UI; schedule fan-out miễn — đậu pending) → dispatch cap
      → metering 60s → pre-PUT artifact (trần 2GB/run + signature sampling) → pre-flight AI
- [ ] **Dispatcher fair-share BẬT**: DRR cost=clamp(ceil(steps/10),1,8), cap/team ≤ 0.5 fleet,
      sàn chống đói 60s; test fairness 50 run/2 tenant/4 slot
- [ ] Lanes: interactive worker riêng pre-warm (p95<3s), batch tenant-pinned; work-stealing sau 120s
- [ ] concurrency_group supersession (cancel-queued mặc định) cho CI push liên tục
- [ ] **AI drafts**: nút Generate → structured outputs ép schema step → validate catalog →
      DRAFT-only; apply có stage resolve element (lạ → pending_locator chặn promote);
      budget reserve pre-flight, per-user daily = team monthly/20; ai_prompt_log
- [ ] Triage đêm qua Batch API: đọc failure_context + trace → phân loại → đề xuất locator thành draft
- [ ] **MCP server** (mcp-gateway): list/get/search, draft_case, trigger_run, get_run_status,
      get_failure_report (schema từ res_step_results.failure_context ≤32KB), element:propose;
      mọi tool qua authorize() + metered + audit token_id; element:write nằm danh sách never-grantable

**Exit:** 2 tenant chạy đêm chồng nhau không đói nhau (đo tenant_starvation_seconds=0);
demo trọn S4 (AI draft → QA promote → chạy) và S5 (Cursor triage → propose → người duyệt).
