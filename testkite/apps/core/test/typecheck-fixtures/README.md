# typecheck-fixtures — DELIBERATELY BROKEN CODE

The `.ts` files here are **meant not to typecheck**. They are fixtures for
`../arch/adapter-guard.test.ts`, which runs `ts.createProgram` over each one and asserts the exact
TypeScript error it must raise (TS1360 / TS2322 / TS2353) — plus one fixture that must raise
nothing at all, the negative control.

Why they live here rather than under `tools/`:

- `apps/core/tsconfig.json` is `"include": ["src"]`, so `test/**` is outside `pnpm typecheck` and
  broken code here can never turn the CI gate red.
- A fixture has to import the REAL DTO (`@testkite/contract`) and the REAL domain type
  (`@testkite/run-compiler`, `../../src/...`). Those packages are linked into
  `apps/core/node_modules/@testkite/` only — there is no `node_modules/@testkite` at the workspace
  root — so a fixture placed in `tools/` would not resolve them, and a fixture built from toy types
  would prove less.
- They are named `*.ts`, not `*.test.ts`, so vitest does not collect them.

**Do not "fix" these files.** A fixture that stops failing means the fence is dead, and
`adapter-guard.test.ts` turns red to say exactly that.

(This file is in English because the CI language gate scans every file under `apps/core/test`,
documentation included.)
