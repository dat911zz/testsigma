/**
 * Flat config của TestKite. `.mjs` chứ không `.js`: workspace root không khai
 * `"type": "module"`, nên `.js` ở đây là CommonJS còn flat config bắt buộc ESM.
 *
 * M1 CHỈ cưỡng chế LUẬT KIẾN TRÚC, không luật style:
 *  - DAG một chiều giữa 12 module apps/core        (Task B2)
 *  - run-compiler PURE + queue chỉ trong kernel     (Task B3)
 * Rule style/recommended để dành — chúng kéo theo hàng loạt sửa vô can.
 *
 * `pnpm lint` chỉ soi `apps` và `packages`. `tools/lint-fixtures/**` cố ý VI PHẠM
 * và được test riêng gọi thẳng qua ESLint Node API (xem tools/lint-rules.test.ts).
 */
import { createRequire } from "node:module";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const MODULE_DAG = Object.fromEntries(
  Object.entries(require("./module-dag.json")).filter(([name]) => !name.startsWith("$")),
);

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
     * Glob mở đầu `**` có chủ đích: nó khớp CẢ file production
     * (`apps/core/src/modules/...`) LẪN fixture (`tools/lint-fixtures/apps/core/src/modules/...`),
     * nên fixture được phân loại y hệt file thật và test luật lint mới có nghĩa.
     */
    files: ["**/apps/core/src/modules/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["**/apps/core/src/modules/**/*.ts"],
      /**
       * BẮT BUỘC. Repo dùng NodeNext: import nội bộ viết `./foo.js` trỏ tới `foo.ts`.
       * Thiếu resolver này, boundaries phân giải dependency ra null và CHO QUA
       * mọi vi phạm trong im lặng — tệ hơn không có lint.
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
            "DAG vi phạm: module '{{from.captured.name}}' không được import '{{to.captured.name}}'. Cạnh ngược/ngang đi bằng domain event qua krn_outbox, không phải import (docs/SYSTEM_DESIGN.md §4).",
          policies: Object.entries(MODULE_DAG).map(([name, allowed]) => ({
            from: { element: { type: "module", captured: { name } } },
            allow: allowed.map((target) => ({ to: { element: { type: "module", captured: { name: target } } } })),
          })),
        },
      ],
    },
  },
];
