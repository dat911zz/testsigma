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
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
  },
];
