/**
 * Child process for `daemon-liveness.test.ts`. NOT a vitest file — the suite's include glob is
 * `test/**\/*.test.ts`, so this is only ever loaded by the spawn in that test.
 *
 * WHY A SEPARATE PROCESS. The property under test is that a booted `Runnerd` KEEPS THE NODE
 * EVENT LOOP ALIVE, and that property does not exist inside vitest: the test runner's own loop is
 * held open by the runner regardless, and `vi.useFakeTimers()` calls the callbacks directly
 * without ever consulting a timer handle's ref state. A daemon whose interval is `unref`'d beats
 * happily under fake timers and exits with code 0 in production. Only a real process shows it.
 *
 * The wiring mirrors `src/runnerd/main.ts` — a synchronous body, no listening socket, SIGTERM and
 * SIGINT handlers, and nothing else that could hold the loop open — with the ONE difference that
 * the control plane is an in-process fake, so the harness makes no network call.
 */
import { register } from "node:module";
import type { RunnerdClient } from "../../src/runnerd/daemon.js";

/**
 * NodeNext writes internal imports as `./psi.js` while the repo ships only `.ts` sources, and
 * Node's type stripping resolves that specifier literally (verified: `ERR_MODULE_NOT_FOUND` for
 * `psi.js`). This hook retries a failed `.js` resolution against the `.ts` file beside it, which
 * is the whole reason the daemon below is imported dynamically: a static import would hoist above
 * `register` and load before the hook exists.
 */
const RESOLVE_TS_SOURCES = `
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".js")) {
    try {
      return await next(specifier.slice(0, -3) + ".ts", context);
    } catch {
      // Not a TypeScript source: fall through to normal resolution.
    }
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`, import.meta.url);

const { Runnerd } = await import("../../src/runnerd/daemon.js");

const intervalMs = Number(process.env["TK_LIVENESS_INTERVAL_MS"] ?? "150");
let beats = 0;

const client: RunnerdClient = {
  register: async (req) => ({
    workerId: req.workerId,
    lane: req.lane,
    workerToken: "tkw_liveness_fake",
    heartbeatIntervalMs: intervalMs,
    drain: false,
  }),
  workerHeartbeat: async () => {
    beats += 1;
    console.log(`beat ${beats}`);
    return { command: "continue", workerTokenRenewedAt: new Date().toISOString() };
  },
};

const daemon = new Runnerd({
  client,
  workerId: "liveness-runnerd",
  hostname: "liveness-host",
  lane: "batch",
  capacity: 4,
  readPsiSample: () => null,
  selfRssBytes: () => 1,
  busySlots: () => 0,
  onDrain: () => {},
  log: () => {},
  intervalMs,
});

daemon.start();
const shutdown = (): void => {
  daemon.stop();
  console.log("stopped");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("booted");
