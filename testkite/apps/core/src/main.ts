/**
 * @testkite/core — Fastify 5 modular monolith entrypoint.
 *
 * IMAGE RULE: this image NEVER contains a browser binary —
 * CI greps the layer manifest, and finding chromium fails the build. The capacity to run
 * tests is a property of the fleet (M containers × K contexts), not of the code.
 */
import { buildApp } from "./composition-root.js";
import { installShutdownHandlers } from "./http/shutdown.js";
import { loadEnv } from "./modules/kernel/env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  // Node terminates on SIGTERM without running a single `onClose` hook. That hook is what
  // releases the dispatcher lease and unbinds the fleet plane, so without this every rolling
  // deploy would leave the fleet with no dispatcher until the lease TTL expires.
  installShutdownHandlers({
    close: () => app.close(),
    onSignal: (signal, handler) => {
      process.once(signal, handler);
    },
    exit: (code) => {
      process.exit(code);
    },
    log: (message, cause) => {
      app.log.error({ err: cause }, message);
    },
  });
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
