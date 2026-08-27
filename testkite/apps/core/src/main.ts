/**
 * @testkite/core — Fastify 5 modular monolith entrypoint.
 *
 * QUY TẮC ẢNH IMAGE: image này KHÔNG BAO GIỜ chứa binary browser —
 * CI grep layer manifest, thấy chromium là fail build. Năng lực chạy test
 * là thuộc tính của fleet (M container × K context), không phải của code.
 */
import { buildApp } from "./composition-root.js";

async function main(): Promise<void> {
  // TODO(M1): zod-validate process env (exit-on-invalid) trước khi build app.
  const app = await buildApp();
  const port = Number(process.env["PORT"] ?? 8080);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
