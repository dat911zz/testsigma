/**
 * runnerd entrypoint — ONE PER HOST. The worker entrypoint is `src/main.ts`, one per container,
 * and the two are deliberately different processes: `runnerd.service` lives OUTSIDE
 * `ts-workers.slice` so the supervisor survives the memory pressure it is reporting on.
 *
 * IDENTITY. Both processes register against the same roster, so this one takes a distinct id:
 * `ts-worker@.service` names its containers `%H-w1..%H-wN` while this daemon registers as
 * `<name>-runnerd`. Sharing one row would have the two disagree about `capacity` and overwrite
 * each other's `free_slots` every five seconds — a roster that lies about the fleet's size.
 *
 * DRAIN IS RELAYED, NOT ENFORCED, HERE. runnerd has no handle on the worker containers (they are
 * podman units owned by systemd), and it does not need one: each worker learns about drain on its
 * OWN heartbeat — `jobHeartbeat` answering `drain` makes `Worker.requestDrain()` finish the chain
 * in flight and stop claiming (src/worker.ts). What this callback adds is the host-level record
 * that the command arrived, so an operator draining a machine can see it landed even if a worker
 * is mid-chain and silent for the next fifteen minutes.
 *
 * THIS FILE IS WIRING, AND WIRING IS NOT TESTED HERE. `Runnerd` has its own suite; what only a
 * real host shows is a `/proc/pressure/memory` that exists at all (`test/host/psi.test.ts`) and a
 * systemd unit that starts this file (`scripts/verify-units.sh`).
 */
import { hostname } from "node:os";
import { loadRunnerConfig } from "../config.js";
import { HttpControlPlaneClient } from "../control-plane-client.js";
import { readRssBytes } from "../memory/rss.js";
import { Runnerd } from "./daemon.js";
import { readPsi } from "./psi.js";

function main(): void {
  // Fail fast and loudly on a bad environment: systemd restarts the unit and its log names the
  // field, which beats a daemon that boots and silently supervises nothing.
  const config = loadRunnerConfig(process.env);
  const log = (message: string): void => {
    console.log(JSON.stringify({ at: new Date().toISOString(), daemon: "runnerd", host: config.workerName, message }));
  };

  const daemon = new Runnerd({
    client: new HttpControlPlaneClient({ baseUrl: config.controlPlaneUrl, bootstrapToken: config.bootstrapToken }),
    workerId: `${config.workerName}-runnerd`,
    hostname: hostname(),
    lane: config.lane,
    capacity: config.maxContexts,
    readPsiSample: () => readPsi(),
    // `readRssBytes` reads THIS process; a null means the read raced a /proc change, and 0 is the
    // honest answer for "not measured right now" — the plane logs the field, it does not gate on it.
    selfRssBytes: () => readRssBytes(process.pid) ?? 0,
    // TODO(M5): the host-level busy count comes from the control plane's own view of this host's
    // leases. runnerd cannot see inside the worker containers, and guessing would be worse than
    // reporting the capacity it was configured with.
    busySlots: () => 0,
    onDrain: () => log("drain command received — workers will finish their chain and stop claiming"),
    log,
    intervalMs: config.heartbeatIntervalMs,
  });

  daemon.start();
  const shutdown = (): void => {
    daemon.stop();
    log("runnerd down");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(`runnerd up for ${config.workerName} (lane=${config.lane}, capacity=${config.maxContexts})`);
}

main();
