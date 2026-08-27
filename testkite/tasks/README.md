# TestKite — Backlog theo milestone

Nguồn sự thật: [`../../docs/SYSTEM_DESIGN.md`](../../docs/SYSTEM_DESIGN.md) (blueprint §7 = lộ trình).
Mỗi milestone một file, mỗi file có **mục tiêu → checklist → exit criteria**. Đánh dấu `- [x]` khi xong,
kèm hash commit bên cạnh. TODO trong code gắn tag `TODO(M<n>)` khớp đúng file ở đây.

> **Quyết định 27-08-2026 — CLEAN BREAK:** không vá/bảo trì hệ cũ nữa (M0 đã xóa khỏi kế hoạch).
> Hệ cũ giữ nguyên trạng tới cutover, chỉ bị *đọc* (dump DB) và *gọi* (REST khi parallel-run) —
> không bao giờ bị sửa. Bảo hiểm dữ liệu duy nhất: mysqldump hằng đêm từ ngoài (nằm trong M7).

| File | Nội dung | Trạng thái |
|---|---|---|
| [M1](M1-kernel-contracts-compiler.md) | Kernel, contracts, **compiler core + golden (xây đầu tiên)**, schema tenancy | 🟢 xong 27-08-2026 |
| [M2](M2-identity-authoring.md) | Identity/RBAC/audit/token + CI cách ly · Authoring + revision/review | 🔴 |
| [M3](M3-orchestration-fleet.md) | Queue Postgres (SKIP LOCKED), dispatcher, worker + memory governance, fleet systemd 3 host, results + SSE | 🔴 |
| [M4](M4-elements-verbs-planning.md) | Elements + capture service · 35 verb + engine golden · testdata · planning | 🔴 |
| [M5](M5-governance-ai-mcp.md) | Quota/metering, fair-share, lanes · AI drafts · MCP | 🔴 |
| [M6](M6-webhooks-observability-dr.md) | Webhooks, egress observe, observability, DR + diễn tập restore, soak T7 | 🔴 |
| [M7](M7-migration-tooling.md) | Script migrate + cổng compile-all · freeze + parallel-run + differ | 🔴 |
| [M8](M8-parallel-cutover.md) | Suite vào 'parallel' theo đợt, đốt diff, flip các suite đầu | 🔴 |
| [M9](M9-full-cutover-hardening.md) | Cutover trọn, hệ cũ read-only, egress enforce, gVisor, buffer | 🔴 |
| [open-questions](open-questions.md) | Câu hỏi mở còn lại (8 quyết định lớn đã chốt 27-08 — xem blueprint) | 🟢 M1 hết bị chặn |

**Lịch (ĐÃ CHỐT):** 9 tháng với +1 kỹ sư fleet — 2 track song song: fleet vs compiler/API. Hạ tầng: tự host. DB: PostgreSQL 17. **Sau GA:** admin UI (P3) trước khi team 3–4 onboard; k8s chỉ khi chạm 2/5 trigger;
decommission hệ cũ +30 ngày sau khi mọi suite ở 'new'.
