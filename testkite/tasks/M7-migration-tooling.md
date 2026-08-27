# M7 — Công cụ migrate + cổng T8

> Căn cứ: blueprint §2 (trình tự bảng, heuristic dedup suite/plan, results 90 ngày).

- [ ] Chạy trước trên production: SELECT entity_type, COUNT(*) GROUP BY — chốt bộ suite/plan thật
- [ ] Migration runner idempotent + resumable + dry-run + row-count invariant + checksum per bảng
- [ ] Thứ tự: tenancy trio → lookups + env (bóc base_url, danh sách chờ operator điền) →
      screens/elements (create_type=migrated) + testdata → cases/steps/loops/rest
      (resolve tên element → FK; fail → pending_locator + report) → suites/plans (heuristic:
      entity_type IS NULL OR IN ('TEST_SUITE','TEST_PLAN'), loại 'Dry run %') → results 90 ngày
      full + rollup cũ hơn → schedules cuối
- [ ] **Cổng T8: compile TOÀN BỘ case đã migrate — zero ERROR**; danh sách case kẹt verb chưa port
      ra TRƯỚC cutover (mỗi verb ~nửa ngày)
- [ ] Diff 50 chain mẫu compiled-plan với kỳ vọng tay
- [ ] Freeze patch hệ cũ (~50 dòng filter ts.migration.readonly, non-GET ⇒ 503) + mutation-count proof
- [ ] migration_state per-suite (old|parallel|new) + routing schedule bắn 2 stack + 
      migration_parallel_runs + **differ** (case, step ordinal)→verdict, map 5→3 tầng, flake filter N=3

**Exit:** dry-run migrate toàn bộ production dump: invariant xanh, T8 zero ERROR
(hoặc danh sách verb cần port đã biết), differ chạy được trên 1 suite thử.
