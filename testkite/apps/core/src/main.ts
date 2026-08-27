/**
 * @testkite/core — Fastify 5 modular monolith entrypoint.
 *
 * QUY TẮC ẢNH IMAGE: image này KHÔNG BAO GIỜ chứa binary browser —
 * CI grep layer manifest, thấy chromium là fail build. Năng lực chạy test
 * là thuộc tính của fleet (M container × K context), không phải của code.
 */
import { buildApp } from "./composition-root.js";
import { loadEnv } from "./modules/kernel/env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
