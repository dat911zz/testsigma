/**
 * @testkite/core — Fastify 5 modular monolith entrypoint.
 *
 * IMAGE RULE: this image NEVER contains a browser binary —
 * CI greps the layer manifest, and finding chromium fails the build. The capacity to run
 * tests is a property of the fleet (M containers × K contexts), not of the code.
 */
import { buildApp } from "./composition-root.js";
import { loadEnv } from "./modules/kernel/env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
