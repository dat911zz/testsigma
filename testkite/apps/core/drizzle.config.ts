import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // The glob keeps the ownership rule intact: each module owns its own schema file,
  // but there is only ONE migration line.
  schema: "./src/modules/*/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Roles are managed by migrations — drizzle-kit will generate CREATE ROLE for pgRole() in Task 4.
  entities: { roles: true },
});
