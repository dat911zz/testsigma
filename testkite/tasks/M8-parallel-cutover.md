# M8 — Parallel-run theo đợt + flip các suite đầu

- [ ] Đợt 1: các suite nhỏ nhất vào migration_state='parallel' (schedule bắn cả 2 stack)
- [ ] Đốt diff về 0 từng suite (disagreement → re-run N=3 tách flake vs khác-engine; fix verb/locator)
- [ ] Flip suite đầu tiên sang 'new'; đóng băng authoring suite đó bên hệ cũ
- [ ] Lặp theo đợt tăng dần kích thước; ghi nhật ký diff-burn-down per suite
- [ ] Đo per-verb duration histogram thật từ parallel-run → hiệu chỉnh sizing fleet
      (giả định 75s/chain chưa đo — mọi con số tuyến tính theo nó)
- [ ] Rollback rehearsal: flip một suite ngược về 'parallel' rồi 'old', xác nhận không mất gì

**Exit:** ≥ 1/3 số suite ở 'new', 0 diff tồn; per-verb histogram thay giả định trong tài liệu sizing.
