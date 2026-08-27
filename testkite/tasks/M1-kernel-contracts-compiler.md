# M1 — Kernel + Contracts + Compiler core (xây ĐẦU TIÊN) + schema tenancy

> Compiler là hợp đồng mà mọi thứ khác tiêu thụ — golden test của nó đi trước orchestration.
> Căn cứ: blueprint §4 (Run Compiler 9 phase), §3 (schema tenancy), §2 (domain ~58 bảng).

## Checklist

- [ ] `pnpm install` + toolchain: tsconfig refs, eslint (+ eslint-boundaries theo `ownership.json`,
      madge --circular, lint cấm `bullmq` ngoài kernel), vitest, CI cơ bản (typecheck + test mỗi PR)
- [ ] **kernel:** Drizzle (driver pg, PostgreSQL 17) + drizzle-kit; migration đầu tiên: bộ ba tenancy + `krn_outbox`/`krn_outbox_consumed`;
      transactional outbox writer + relay skeleton; zod-validate env (exit-on-invalid)
- [ ] **contract:** zod schemas cho case/step/element/run + sinh OpenAPI 3.1, commit spec,
      CI fail khi regen drift
- [ ] **run-plan schema:** RunPlan/ChainPlan/CasePlan/StepPlan hoàn chỉnh + canonicalize + SHA-256 + zstd
      + `planFormatVersion`
- [x] **compiler phase 1:** resolve chuỗi prereq — cycle check, depth ≤ 5, ghim revision
      ('ready' cho schedule/CI, 'latest' cho ad-hoc author)
- [x] **compiler phase 2:** nở step group (local ≤ 5 tầng), if/loop → cây block,
      data-driven fan-out + `expected_to_fail`
- [ ] **compiler phase 3–5:** bind verb vào registry (GOM mọi lỗi), element → LocatorSet
      (`pending_locator` ⇒ diagnostic), merge data/env với `$secretRef`
- [ ] **compiler phase 6–7:** stamp policy/tenant + freeze; mọi `CompileErrorCode` có fixture âm
- [ ] **Golden tests (T1):** cùng input ⇒ cùng `content_hash`; bộ fixture phủ mọi construct
      (prereq chain, group lồng, if, for, data-driven)
- [ ] Schema tenancy migration: organizations/teams/projects/users/memberships +
      composite-FK pattern mẫu cho một bảng asset đầu tiên

## Exit criteria

- `pnpm test` xanh với bộ golden compiler ≥ 20 fixture (dương + âm).
- Compile một case mẫu tay-dựng ra RunPlan freeze được, hash ổn định qua 2 lần chạy.
