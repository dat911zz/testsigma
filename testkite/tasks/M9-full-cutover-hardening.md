# M9 — Cutover trọn + hardening + buffer

- [ ] Các suite còn lại theo đợt; **suite khủng của census đi CUỐI**
- [ ] Hệ cũ chuyển read-only (giữ làm kho lịch sử; decommission +30 ngày sau suite cuối)
- [ ] Egress chuyển observe → enforce khi các cửa sổ 14 ngày lần lượt hết
- [ ] gVisor runtime cho tenant gắn cờ hardened; canary theo browser upgrade
- [ ] Succession docs: BUILDING/RUNBOOK cập nhật, OpenAPI commit, bảng ngữ nghĩa 35 verb
  - [x] RUNBOOK trang đầu tiên — vai DB: `../docs/runbook-db-roles.md` (+ `../scripts/grant-db-roles.sql`, checker `kernel/db/role-separation.ts`) — M3-debt D3
- [ ] **Cutover, trước khi mở traffic trên MỖI cụm:** chạy
  `psql "$ADMIN_URL" -v check_only=1 -f scripts/grant-db-roles.sql` — cả ba bất biến (INV-1/2/3) phải RỖNG. CI không chứng minh được điều này thay cụm production: login của CI là superuser `postgres` và không migration nào tạo login role (`../docs/runbook-db-roles.md` §6).
- [ ] Buffer 2–3 tuần cho nợ phát sinh từ M7–M8

**Exit:** 100% suite ở 'new'; một chu kỳ đêm trọn vẹn 3 team (nếu đã onboard) xanh;
hệ cũ read-only không còn traffic ghi.
