# CLAUDE.md — Luật làm việc trong repo này

## Bối cảnh 10 giây

- Repo gốc = Testsigma (legacy, vendor bỏ rơi): `server/` (Spring Boot), `ui/` (Angular 12),
  `automator/`, `agent/`. **CLEAN BREAK — không bao giờ sửa code legacy**; hệ cũ chỉ bị
  *đọc* (dump DB) hoặc *gọi* (REST). Mọi code mới nằm trong `testkite/`.
- Blueprint sống: `docs/SYSTEM_DESIGN.md`. Backlog: `testkite/tasks/` (M1→M9).
  Plan implement: `testkite/tasks/plans/`. Lịch sử quyết định: `docs/ARCHITECTURE_AUDIT.md`.
- Nhánh làm việc: `claude/legacy-project-architecture-yo4td4` — push bằng
  `git push -u origin <branch>`, không push nhánh khác.

## Luật 1 — Dùng Serena MCP khi đụng vào source code

Serena đã cấu hình sẵn trong `.mcp.json` (language server: java + typescript). Khi điều hướng
hoặc sửa code — **đặc biệt trong codebase legacy rất lớn** — ưu tiên tool Serena thay vì đọc
nguyên file để tiết kiệm token:

- Tra cứu: `get_symbols_overview` → `find_symbol` → `find_referencing_symbols`
  (thay cho Read cả file / grep mò).
- Sửa: `replace_symbol_body`, `insert_after_symbol`, `rename_symbol`
  (thay cho Edit chuỗi dài).
- Chỉ Read nguyên file khi file nhỏ (<200 dòng) hoặc cần ngữ cảnh liền mạch (doc, config).
- Kiến thức tích luỹ về dự án ghi vào Serena memory (`write_memory`) thay vì file rác.

## Luật 2 — Dùng Superpowers skills cho mọi việc kỹ thuật

Bộ skill đã vendor tại `.claude/skills/` (nguồn obra/superpowers, MIT — xem ATTRIBUTION).
Bắt buộc theo đúng nghi thức:

| Việc | Skill phải dùng |
|---|---|
| Trước khi thiết kế/quyết định lớn | `brainstorming` |
| Trước khi implement bất kỳ hạng mục nào | `writing-plans` (plan nằm ở `testkite/tasks/plans/`) |
| Thực thi plan | `executing-plans` hoặc `subagent-driven-development` |
| Viết code có logic | `test-driven-development` — test ĐỎ trước, code sau; không viết code trước test |
| Gặp bug | `systematic-debugging` — tìm root cause, không vá mù |
| Trước khi tuyên bố "xong" | `verification-before-completion` — chạy verify thật, dán output |
| Review | `requesting-code-review` / `receiving-code-review` |
| Cuối mỗi milestone | **Polish wave** (chốt 28-08-2026): gặt toàn bộ nit các reviewer đã ghi + 3 lượt rà soát chéo (an ninh end-to-end · đơn giản hoá/nhất quán · chất lượng test), phân loại áp/bỏ/hoãn có lý do, áp fix bằng pipeline impl/review thường lệ TRƯỚC khi nghiệm thu milestone |

## Luật 3 — Phân model theo việc (tiết kiệm chi phí)

Khi cử subagent/workflow: **scan/recon source code → model nhỏ (Sonnet/Haiku)**;
strategy/design/implement → Opus; chỉ judge/synthesis cuối mới dùng model lớn nhất.

## Luật 4 — Chuẩn code TestKite

- **NGÔN NGỮ (chốt 28-08-2026): mọi CODE và TEST viết TIẾNG ANH** — comment, docstring,
  tên test (`describe`/`it`), message lỗi/diagnostic, log. Tài liệu (`docs/`, `tasks/`,
  plan) vẫn tiếng Việt. Chuỗi hiển thị cho người dùng cuối đi qua i18n (vi+en), không
  hardcode. Plan cũ có block code tiếng Việt thì implementer DỊCH sang tiếng Anh khi
  viết, giữ nguyên hành vi. Gate máy: grep ký tự có dấu tiếng Việt trong `src/**`,
  `test/**`, `tools/**` phải = 0 (trừ file fixture dữ liệu có chủ đích).
- TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), NodeNext,
  Node 22, pnpm workspace, vitest. Không `any`, không `!` phi lý.
- Compiler (`packages/run-compiler`) là PURE — cấm import fs/net/db, cấm `Date.now()`.
- Ảnh API không chứa browser (CI grep gate). Worker zero-credential.
- Commit nhỏ theo từng task, tick checkbox trong `testkite/tasks/` kèm hash commit.
