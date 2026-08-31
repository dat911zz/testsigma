/**
 * TestKite's flat config. `.mjs`, not `.js`: the workspace root does not declare
 * `"type": "module"`, so `.js` here would be CommonJS while flat config requires ESM.
 *
 * M1 enforces ARCHITECTURE RULES ONLY, not style rules:
 *  - one-way DAG across the 12 apps/core modules   (Task B2)
 *  - run-compiler PURE + queue confined to kernel  (Task B3)
 * Style/recommended rules are deferred — they drag in a pile of unrelated fixes.
 *
 * `pnpm lint` only targets `apps` and `packages`. `tools/lint-fixtures/**` deliberately
 * VIOLATES the rules and is tested separately through the ESLint Node API directly
 * (see tools/lint-rules.test.ts).
 */
import { createRequire } from "node:module";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const MODULE_DAG = Object.fromEntries(
  Object.entries(require("./module-dag.json")).filter(([name]) => !name.startsWith("$")),
);

/**
 * `no-restricted-imports` ONLY inspects STATIC `import` statements: `await import("node:fs")`
 * slips through with zero errors (reproduced on eslint 10.9.1 with a minimal config outside
 * this repo — not a repo glob bug). So every forbidden list needs a regex twin guarding
 * `ImportExpression` via `no-restricted-syntax`; the two copies must always stay in sync —
 * edit one list, edit its matching regex too.
 */
const dynamicImportOf = (modulePattern) => `ImportExpression > Literal[value=/${modulePattern}/]`;
const IO_MODULES =
  "^(node:)?(fs|net|dns|tls|http|https|child_process|worker_threads|cluster|os|process|path|url|timers)(\\/|$)";
const SERVICE_MODULES = "^(pg|pg-[^\\/]*|postgres|drizzle-orm|drizzle-kit|bullmq|ioredis|@testkite\\/core)(\\/|$)";
const QUEUE_MODULES = "^(bullmq|ioredis)(\\/|$)";
/** Twin of the runner's `no-restricted-imports` group — edit one, edit the other. */
const RUNNER_FORBIDDEN_MODULES = "^(@testkite\\/core|pg|pg-[^\\/]*|postgres|drizzle-orm|drizzle-kit)(\\/|$)";
/**
 * Shared by `BROWSER_DRIVER_IMPORTS` and its `await import()` twin below — one string, so the
 * static and dynamic forms cannot drift apart. The SCOPED alternative is spelled out rather
 * than left to a bare `playwright` prefix: `@playwright/test` puts the scope first, so any
 * pattern anchored on the driver name never sees it (the same hole the CI browser gates carried
 * until 31-08-2026).
 */
const BROWSER_DRIVER_MODULES =
  "^(playwright|playwright-[^\\/]*|@playwright\\/[^\\/]*|puppeteer|puppeteer-[^\\/]*)(\\/|$)";

/**
 * L1 isolation (blueprint §3). A raw `TkDb` carries NO tenant: it hasn't run
 * `SET LOCAL ROLE testkite_app` or `set_config('app.team_id', …)`, so RLS has no predicate to
 * filter on. Any tenant-scoped query must run on a `TkTx` — the kind `withTenant()` hands out —
 * or through `TenantRepo` (which only ever touches `this.tx`). `.transaction()` is the worst
 * offender: opening a transaction straight on the raw handle means the whole transaction lives
 * without a tenant.
 *
 * The list below is the ENTIRE query entrypoint surface of `PgDatabase` (drizzle-orm 0.45.2,
 * `pg-core/db.d.ts`) — missing even one leaves exactly one way through.
 */
const DB_QUERY_ENTRYPOINTS =
  "^(select|selectDistinct|selectDistinctOn|insert|update|delete|refreshMaterializedView|execute|transaction|query|with|\\$with|\\$count)$";

/**
 * Identifies a RAW handle BY NAME: `db`, `deps.db`, `this.#db`, or an identifier ending in
 * `Db` (`appDb`, `testDb`). Deliberately does NOT match `tx`/`this.tx` — that's the valid form.
 *
 * This is a syntactic guard, not a proof: assign through an intermediate variable and the
 * selector won't see it. The load-bearing layer is still the fail-closed `assertTenantContext`
 * in `kernel/db/repo.ts` plus RLS; this rule only blocks the violation shape that's easiest to
 * miss when reading a diff.
 */
const RAW_DB_RECEIVER = "^(db|.*Db)$";

const rawDbQuery = {
  selector: `MemberExpression[property.name=/${DB_QUERY_ENTRYPOINTS}/]:matches([object.name=/${RAW_DB_RECEIVER}/], [object.property.name=/${RAW_DB_RECEIVER}/])`,
  message:
    "L1 isolation: building a query on a raw DB handle is forbidden — the raw handle has neither an app role nor app.team_id, so RLS filters nothing. Go through withTenant(db, ctx, tx => …) or TenantRepo (docs/SYSTEM_DESIGN.md §3).",
};

/**
 * The runner's two bans, hoisted to constants because TWO blocks now configure these rules for
 * runner files. Flat config REPLACES a rule's options rather than merging them, so the browser
 * adapter's override has to restate every ban it still wants — sharing the objects is what stops
 * the override from silently becoming a hole in the zero-credential rule as well.
 */
const RUNNER_ZERO_CREDENTIAL_IMPORTS = {
  group: [
    "@testkite/core", "@testkite/core/*",
    "pg", "pg-*", "postgres",
    "drizzle-orm", "drizzle-orm/*", "drizzle-kit",
  ],
  message:
    "The runner is zero-credential and process-separate: it must not import the core app or any DB driver. Talk to the control plane through src/control-plane-client.ts (docs/SYSTEM_DESIGN.md §5).",
};
const RUNNER_ZERO_CREDENTIAL_DYNAMIC = {
  selector: dynamicImportOf(RUNNER_FORBIDDEN_MODULES),
  message:
    "The runner is zero-credential and process-separate: `await import()` of the core app or a DB driver ships the same driver into the worker image. Talk to the control plane through src/control-plane-client.ts (docs/SYSTEM_DESIGN.md §5).",
};
/**
 * `regex`, not `group`, and it is the SAME string the dynamic twin uses — which is the point:
 * the two copies can no longer drift because there is only one copy.
 *
 * `group` was measured wrong here on 31-08-2026: its patterns are gitignore-style and match any
 * PATH SEGMENT, so `playwright-*` flagged `import { launchPlaywrightEngine } from
 * "./browser/playwright-engine.js"` — a relative import of the adapter, i.e. exactly the
 * architecture this rule is meant to protect. A rule that fires on correct code is a rule that
 * gets deleted. The regex is anchored with `^`, so only a bare module specifier can match.
 */
const BROWSER_DRIVER_IMPORTS = {
  regex: BROWSER_DRIVER_MODULES,
  message:
    "Only src/browser/playwright-engine.ts may import a browser driver. Everywhere else in the runner drives the browser through the BrowserEngine port, so swapping or faking the driver stays a one-file change (docs/SYSTEM_DESIGN.md §5).",
};
const BROWSER_DRIVER_DYNAMIC = {
  selector: dynamicImportOf(BROWSER_DRIVER_MODULES),
  message:
    "Only src/browser/playwright-engine.ts may import a browser driver — `await import(\"playwright-core\")` loads the very same driver into the very same file. Go through the BrowserEngine port (docs/SYSTEM_DESIGN.md §5).",
};

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
  },
  {
    /**
     * The leading `**` glob is deliberate: it matches BOTH production files
     * (`apps/core/src/modules/...`) AND fixtures (`tools/lint-fixtures/apps/core/src/modules/...`),
     * so fixtures get classified exactly like real files and the lint-rule tests are meaningful.
     */
    files: ["**/apps/core/src/modules/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["**/apps/core/src/modules/**/*.ts"],
      /**
       * REQUIRED. The repo uses NodeNext: internal imports are written `./foo.js` pointing at
       * `foo.ts`. Without this resolver, boundaries resolves the dependency to null and silently
       * LETS THROUGH every violation — worse than no lint at all.
       */
      "import/resolver": { typescript: { project: "./tsconfig.base.json" } },
      "boundaries/elements": [{ type: "module", pattern: "apps/core/src/modules/*", capture: ["name"] }],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "DAG violation: module '{{from.captured.name}}' must not import '{{to.captured.name}}'. Backward/lateral edges go through a domain event via krn_outbox, not an import (docs/SYSTEM_DESIGN.md §4).",
          policies: Object.entries(MODULE_DAG).map(([name, allowed]) => ({
            from: { element: { type: "module", captured: { name } } },
            allow: allowed.map((target) => ({ to: { element: { type: "module", captured: { name: target } } } })),
          })),
        },
      ],
    },
  },
  {
    /**
     * Compiler is PURE (CLAUDE.md Rule 4): same input ⇒ same content hash, forever.
     * `node:crypto` is NOT forbidden — phase 7 hashes via `createHash`, which is pure
     * computation. `*.test.ts` is exempt: golden.test.ts reads 20+ fixtures via node:fs.
     */
    files: ["**/packages/run-compiler/src/**/*.ts"],
    ignores: ["**/packages/run-compiler/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              /**
               * Every builtin needs BOTH forms: `node:x` AND bare `x`. Node loads
               * `import { execSync } from "child_process"` identically to `node:child_process`,
               * so omitting the bare form leaves open the exact hole this is meant to close.
               */
              group: [
                "fs", "fs/*", "node:fs", "node:fs/*",
                "net", "node:net", "dns", "node:dns", "tls", "node:tls",
                "http", "https", "node:http", "node:https",
                "child_process", "node:child_process",
                "worker_threads", "node:worker_threads",
                "cluster", "node:cluster",
                "os", "node:os", "process", "node:process",
                "path", "path/*", "node:path", "node:path/*",
                "url", "node:url",
                "timers", "timers/*", "node:timers", "node:timers/*",
              ],
              message:
                "run-compiler must stay PURE: fs/net/process/timer are forbidden. node:crypto is allowed (phase 7 hashing). Fetching data is orchestration's job — the compiler only ever receives an already-fetched snapshot.",
            },
            {
              group: [
                "pg", "pg-*", "postgres",
                "drizzle-orm", "drizzle-orm/*", "drizzle-kit",
                "bullmq", "bullmq/*", "ioredis", "ioredis/*",
                "@testkite/core", "@testkite/core/*",
              ],
              message:
                "run-compiler must stay PURE: db/queue/app are forbidden. The compiler is a function, not a service.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: dynamicImportOf(IO_MODULES),
          message:
            "run-compiler must stay PURE: `await import()` loading fs/net/process/timer is still I/O, not a loophole. node:crypto is still allowed.",
        },
        {
          selector: dynamicImportOf(SERVICE_MODULES),
          message: "run-compiler must stay PURE: `await import()` loading db/queue/app still turns the compiler into a service.",
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "run-compiler must stay PURE: env comes in through EnvSnapshot, not process.env." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "run-compiler must stay PURE: Date.now() makes the content hash drift between two compiles." },
        { object: "Math", property: "random", message: "run-compiler must stay PURE: Math.random() makes the content hash drift between two compiles." },
      ],
    },
  },
  {
    /**
     * Modules OUTSIDE the kernel. Every rule in this scope is deliberately gathered into ONE
     * block: flat config does not merge options for the same rule — a later block OVERWRITES
     * the earlier block's options entirely. Splitting `no-restricted-syntax` into a second
     * block with the same `files` would silently wipe out the earlier block's selector. Add a
     * rule in this same scope to the array below.
     *
     *  - BullMQ/Valkey only lives in the kernel (relay + dispatcher). A module that needs to
     *    emit work writes to the outbox in the same transaction — it never holds a queue client
     *    itself.
     *  - L1 isolation: no building a query on a raw DB handle (see `rawDbQuery`).
     */
    files: ["**/apps/core/src/modules/**/*.ts"],
    ignores: ["**/apps/core/src/modules/kernel/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bullmq", "bullmq/*", "ioredis", "ioredis/*"],
              message:
                "The queue client may only be imported inside modules/kernel. Other modules emit work by writing to krn_outbox in the same transaction (docs/SYSTEM_DESIGN.md §4).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: dynamicImportOf(QUEUE_MODULES),
          message:
            "The queue client may only be imported inside modules/kernel — `await import(\"bullmq\")` too. Other modules write to krn_outbox in the same transaction (docs/SYSTEM_DESIGN.md §4).",
        },
        rawDbQuery,
      ],
    },
  },
  {
    /**
     * The shell layer (`composition-root.ts`, `main.ts`, `http/**`): where the raw handle is
     * created and threaded down, so it's also where a tenant-less transaction is most likely to
     * slip through. The shell PASSES `db` into `withTenant()` and never queries on it directly.
     *
     * `ignores` excludes `modules/**` since that scope is already handled by the block right
     * above — two blocks both setting `no-restricted-syntax` on overlapping files would have
     * the later block wipe out the earlier block's selector.
     */
    files: ["**/apps/core/src/**/*.ts"],
    ignores: ["**/apps/core/src/modules/**"],
    rules: {
      "no-restricted-syntax": ["error", rawDbQuery],
    },
  },
  {
    /**
     * The runner is a SEPARATE PROCESS in a separate image (docs/SYSTEM_DESIGN.md §5). It talks
     * to the control plane over internal HTTP only. Importing the core app would (a) drag the DB
     * driver into the worker image, breaking the zero-credential rule, and (b) let a refactor
     * silently reintroduce direct table access from a worker.
     *
     * `no-restricted-syntax` carries the twin regex for `await import(...)`, which
     * `no-restricted-imports` cannot see (see the note on `dynamicImportOf` above) — the two
     * lists must stay in sync.
     *
     * The second ban is the BROWSER DRIVER. "playwright-engine.ts is the only file that touches
     * Playwright" was written as a comment and measured true by grep, which is exactly the state
     * the other twelve architecture rules here were promoted out of: a property nothing enforces
     * is a property that holds until the first hurried diff.
     */
    files: ["**/apps/runner/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [RUNNER_ZERO_CREDENTIAL_IMPORTS, BROWSER_DRIVER_IMPORTS] },
      ],
      "no-restricted-syntax": ["error", RUNNER_ZERO_CREDENTIAL_DYNAMIC, BROWSER_DRIVER_DYNAMIC],
    },
  },
  {
    /**
     * THE adapter — the one file the rule above exists to carve out. Keyed to the exact path,
     * not to `browser/`, so a second driver-aware file next to it is still caught.
     *
     * It restates the zero-credential ban rather than inheriting it: flat config overwrites a
     * rule's options wholesale, so an override that listed nothing would hand this file a free
     * pass on `pg` and `@testkite/core` too. `tools/lint-rules.test.ts` holds a fixture for
     * precisely that mistake.
     */
    files: ["**/apps/runner/src/browser/playwright-engine.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [RUNNER_ZERO_CREDENTIAL_IMPORTS] }],
      "no-restricted-syntax": ["error", RUNNER_ZERO_CREDENTIAL_DYNAMIC],
    },
  },
];
