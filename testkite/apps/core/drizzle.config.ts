import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // The list keeps the ownership rule intact: each module owns its own schema file(s),
  // but there is only ONE migration line.
  //
  // A module that outgrows a single file names each extra file HERE, explicitly. A wildcard
  // such as `*schema.ts` would be shorter and wrong: it would also swallow the hand-written,
  // partitioned tables that are deliberately kept out of drizzle-kit's reach
  // (governance/db/audit-schema.ts), and drizzle-kit would replace their DDL with a flat
  // CREATE TABLE. Explicit list = a new file is only generated once someone decided it should be.
  schema: [
    "./src/modules/*/db/schema.ts",
    "./src/modules/orchestration/db/run-schema.ts",
    "./src/modules/orchestration/db/job-schema.ts",
    "./src/modules/governance/db/usage-schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  // Roles are managed by migrations — drizzle-kit will generate CREATE ROLE for pgRole() in Task 4.
  entities: { roles: true },
});
