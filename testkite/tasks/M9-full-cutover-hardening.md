# M9 — Cutover trọn + hardening + buffer

- [ ] Các suite còn lại theo đợt; **suite khủng của census đi CUỐI**
- [ ] Hệ cũ chuyển read-only (giữ làm kho lịch sử; decommission +30 ngày sau suite cuối)
- [ ] Egress chuyển observe → enforce khi các cửa sổ 14 ngày lần lượt hết
- [ ] gVisor runtime cho tenant gắn cờ hardened; canary theo browser upgrade
- [ ] Succession docs: BUILDING/RUNBOOK cập nhật, OpenAPI commit, bảng ngữ nghĩa 35 verb
- [ ] Buffer 2–3 tuần cho nợ phát sinh từ M7–M8

**Exit:** 100% suite ở 'new'; một chu kỳ đêm trọn vẹn 3 team (nếu đã onboard) xanh;
hệ cũ read-only không còn traffic ghi.
