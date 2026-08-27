# TestKite — Backlog theo milestone

Nguồn sự thật: [`../../docs/SYSTEM_DESIGN.md`](../../docs/SYSTEM_DESIGN.md) (blueprint §7 = lộ trình).
Mỗi milestone một file, mỗi file có **mục tiêu → checklist → exit criteria**. Đánh dấu `- [x]` khi xong,
kèm hash commit bên cạnh. TODO trong code gắn tag `TODO(M<n>)` khớp đúng file ở đây.

| File | Nội dung | Trạng thái |
|---|---|---|
| [M0](M0-old-system-stopgaps.md) | **Vá hệ cũ sống 6–9 tháng** (OOM stopgaps + tháo bom vendor) — làm TRƯỚC mọi thứ | 🔴 chưa bắt đầu |
| [M1](M1-kernel-contracts-compiler.md) | Kernel, contracts, **compiler core + golden (xây đầu tiên)**, schema tenancy | 🟡 scaffold xong |
| [M2](M2-identity-authoring.md) | Identity/RBAC/audit/token + CI cách ly · Authoring + revision/review | 🔴 |
| [M3](M3-orchestration-fleet.md) | Queue MySQL, dispatcher, worker + memory governance, fleet systemd 2 host, results + SSE | 🔴 |
| [M4](M4-elements-verbs-planning.md) | Elements + capture service · 35 verb + engine golden · testdata · planning | 🔴 |
| [M5](M5-governance-ai-mcp.md) | Quota/metering, fair-share, lanes · AI drafts · MCP | 🔴 |
| [M6](M6-webhooks-observability-dr.md) | Webhooks, egress observe, observability, DR + diễn tập restore, soak T7 | 🔴 |
| [M7](M7-migration-tooling.md) | Script migrate + cổng compile-all · freeze + parallel-run + differ | 🔴 |
| [M8](M8-parallel-cutover.md) | Suite vào 'parallel' theo đợt, đốt diff, flip các suite đầu | 🔴 |
| [M9](M9-full-cutover-hardening.md) | Cutover trọn, hệ cũ read-only, egress enforce, gVisor, buffer | 🔴 |
| [open-questions](open-questions.md) | 10 câu hỏi mở cần maintainer chốt — 2 cái chặn M1 | ⚠️ |

**Lịch:** 9 tháng với +1 kỹ sư fleet (2 track song song: fleet vs compiler/API), hoặc ~12 tháng solo
(giãn M3–M6). **Sau GA:** admin UI (P3) trước khi team 3–4 onboard; k8s chỉ khi chạm 2/5 trigger;
decommission hệ cũ +30 ngày sau khi mọi suite ở 'new'.
