# M1 — Kernel + Contracts + Compiler core (xây ĐẦU TIÊN) + schema tenancy

> Compiler là hợp đồng mà mọi thứ khác tiêu thụ — golden test của nó đi trước orchestration.
> Căn cứ: blueprint §4 (Run Compiler 9 phase), §3 (schema tenancy), §2 (domain ~58 bảng).

## Checklist

- [ ] `pnpm install` + toolchain: tsconfig refs, eslint (+ eslint-boundaries theo `ownership.json`,
      madge --circular, lint cấm `bullmq` ngoài kernel), vitest, CI cơ bản (typecheck + test mỗi PR)
- [x] **kernel:** Drizzle (driver pg, PostgreSQL 17) + drizzle-kit; migration đầu tiên: bộ ba tenancy + `krn_outbox`/`krn_outbox_consumed`;
      transactional outbox writer + relay skeleton; zod-validate env (exit-on-invalid)
      (hash: ea91f68, b1e5ccd, 13e44bb, 8e53a08)
- [ ] **contract:** zod schemas cho case/step/element/run + sinh OpenAPI 3.1, commit spec,
      CI fail khi regen drift
- [x] **run-plan schema:** RunPlan/ChainPlan/CasePlan/StepPlan hoàn chỉnh + canonicalize + SHA-256 + zstd
      + `planFormatVersion` (zstd để planFormatVersion=2) (hash: 6a64ff2)
- [x] **compiler phase 1:** resolve chuỗi prereq — cycle check, depth ≤ 5, ghim revision
      ('ready' cho schedule/CI, 'latest' cho ad-hoc author)
- [x] **compiler phase 2:** nở step group (local ≤ 5 tầng), if/loop → cây block,
      data-driven fan-out + `expected_to_fail`
- [x] **compiler phase 3–5:** bind verb vào registry (GOM mọi lỗi), element → LocatorSet
      (`pending_locator` ⇒ diagnostic), merge data/env với `$secretRef` (hash: 98cabed, c242e82)
- [x] **compiler phase 6–7:** stamp policy/tenant + freeze; mọi `CompileErrorCode` có fixture âm (hash: 6a64ff2)
- [x] **Golden tests (T1):** cùng input ⇒ cùng `content_hash`; bộ fixture phủ mọi construct
      (prereq chain, group lồng, if, for, data-driven) (hash: 7c5ca5c)
- [x] Schema tenancy migration: organizations/teams/projects/users/memberships +
      composite-FK pattern mẫu cho một bảng asset đầu tiên (hash: 359ef76, 877734e, 9218d72)

## Exit criteria

- `pnpm test` xanh với bộ golden compiler ≥ 20 fixture (dương + âm).
- Compile một case mẫu tay-dựng ra RunPlan freeze được, hash ổn định qua 2 lần chạy.
