import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Glob giữ đúng luật ownership: mỗi module tự giữ schema file của mình,
  // nhưng chỉ có MỘT dòng migration.
  schema: "./src/modules/*/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Role do migration quản lý — drizzle-kit sẽ sinh CREATE ROLE cho pgRole() ở Task 4.
  entities: { roles: true },
});
