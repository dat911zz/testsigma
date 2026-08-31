/**
 * runnerd — the host supervisor (docs/SYSTEM_DESIGN.md §5).
 *
 * The load-bearing property is that runnerd is OFF THE DATA PATH: it registers the host,
 * heartbeats with PSI and RSS, and relays the control plane's answer. If runnerd dies, chains
 * keep running — systemd restarts it and it re-registers. That is also why no host in this fleet
 * listens on an inbound port: commands ride back on the heartbeat RESPONSE, so the only direction
 * a connection is ever opened is outwards.
 *
 * CONTRACT. The bodies are `registerRequestSchema` and `workerHeartbeatRequestSchema` from
 * `@testkite/contract`, reached through `ControlPlaneClient` — this file re-declares neither, and
 * `RunnerdClient` is a `Pick` of that interface so a method whose shape changes over there breaks
 * THIS build. Two consequences the fleet plan's Task 17 block predates:
 *   - the heartbeat carries `freeSlots`, not a busy count, and `psi` is an OBJECT
 *     (`{ some10, full10 }`) that is OMITTED when the kernel has no pressure file. Sending a
 *     zeroed sample instead would report a thrashing host as perfectly calm.
 *   - registration answers with `heartbeatIntervalMs` and `drain`. Both are obeyed: the plane owns
 *     the cadence, and a host that was put into drain before it restarted STAYS drained —
 *     re-registering must not be a way for a machine to un-drain itself.
 *
 * DRAIN IS A ONE-WAY DOOR for the life of the process. `onDrain` fires at most once, and once
 * drained `heartbeatOnce` keeps answering "drain" even if a later beat says "continue", because
 * the observable effect (workers finishing their chain and not claiming another) has already
 * started and half-reversing it would put the host back in service mid-retirement. A deliberate
 * un-drain arrives the way every other lifecycle change does: systemd restarts the unit.
 *
 * WHAT IS PROVEN WHERE. `test/runnerd/daemon.test.ts` drives this class against a stub plane, so
 * it proves ORDER, PAYLOAD SHAPE, the drain state machine and the scheduler — never that a real
 * control plane accepts these bodies (that is `apps/core`'s internal-plane suites) and never that
 * a real kernel's PSI moves under load (`test/host/psi.test.ts`, gated behind `test:host`).
 */
import type { ControlPlaneClient } from "../control-plane-client.js";
import { watermarkFor, type PsiSample, type Watermark } from "./psi.js";

/**
 * Exactly the two calls a host supervisor may make. Derived from the worker's client rather than
 * written out again: runnerd must never grow the ability to claim a job, and `Pick` says so in a
 * way the compiler enforces.
 */
export type RunnerdClient = Pick<ControlPlaneClient, "register" | "workerHeartbeat">;

export interface RunnerdDeps {
  readonly client: RunnerdClient;
  /** This daemon's roster identity — distinct from any worker container's (see runnerd/main.ts). */
  readonly workerId: string;
  readonly hostname: string;
  readonly lane: "interactive" | "batch";
  /** Contexts this host can serve; the contract accepts 1..16. */
  readonly capacity: number;
  readonly readPsiSample: () => PsiSample | null;
  readonly selfRssBytes: () => number;
  readonly busySlots: () => number;
  readonly onDrain: () => void;
  readonly log: (message: string) => void;
  /** The opening guess only: the plane's `heartbeatIntervalMs` replaces it at registration. */
  readonly intervalMs?: number;
}

/** Blueprint §5: 5s. Used until the control plane publishes its own cadence at registration. */
const DEFAULT_HEARTBEAT_MS = 5_000;

export class Runnerd {
  readonly #deps: RunnerdDeps;
  #registered = false;
  #watermark: Watermark = "green";
  #drained = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #intervalMs: number;
  /** Guards against a slow plane stacking beats: one in flight, the next tick is skipped. */
  #inFlight = false;

  constructor(deps: RunnerdDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_MS;
  }

  watermark(): Watermark {
    return this.#watermark;
  }

  async heartbeatOnce(): Promise<"continue" | "drain"> {
    try {
      if (!this.#registered) await this.#register();

      const sample = this.#deps.readPsiSample();
      this.#applyWatermark(sample);

      const answer = await this.#deps.client.workerHeartbeat({
        freeSlots: Math.max(0, Math.floor(this.#deps.capacity - this.#deps.busySlots())),
        // Omitted, not nulled: the contract's `psi` is optional and a zeroed sample would be a lie.
        ...(sample === null ? {} : { psi: { some10: sample.some10, full10: sample.full10 } }),
        rssBytes: Math.max(0, Math.round(this.#deps.selfRssBytes())),
      });

      if (answer.workerTokenRenewedAt === null) {
        // `touchWorker` renews nothing when the UPDATE matched no row, which means this host's
        // roster row is gone — it was deregistered mid-flight, and the answer will be "drain".
        this.#deps.log("the control plane renewed nothing: this host's roster row is gone");
      }
      if (answer.command === "drain") this.#drain("the control plane asked this host to drain");
      return this.#drained ? "drain" : answer.command;
    } catch (err) {
      // runnerd failing must never take the data path with it: the workers are separate processes
      // and their chains are unaffected by a supervisor that cannot reach the control plane.
      this.#deps.log(
        `runnerd heartbeat failed (chains keep running): ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.#drained ? "drain" : "continue";
    }
  }

  /**
   * The interval stays REF'd on purpose, and `unref()` here would be fatal: `runnerd/main.ts` has
   * a synchronous body, opens no listening socket (commands ride back on the heartbeat response —
   * see the header) and registers only signal handlers, which Node does not count towards keeping
   * the loop alive. This timer is therefore the ONLY thing holding the daemon's process open; an
   * unref'd one made `runnerd.service` log "runnerd up" and exit 0 before its first register, a
   * clean exit systemd's `Restart=on-failure` would not even restart. `stop()` is what releases
   * it, so a ref'd interval costs nothing at shutdown (`test/runnerd/daemon-liveness.test.ts`).
   */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#inFlight) {
        this.#deps.log("skipping a heartbeat tick: the previous one has not been answered yet");
        return;
      }
      this.#inFlight = true;
      // `heartbeatOnce` swallows its own failures, so this can only settle.
      void this.heartbeatOnce().finally(() => {
        this.#inFlight = false;
      });
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  async #register(): Promise<void> {
    const answer = await this.#deps.client.register({
      workerId: this.#deps.workerId,
      hostname: this.#deps.hostname,
      lane: this.#deps.lane,
      capacity: this.#deps.capacity,
    });
    this.#registered = true;
    this.#adoptInterval(answer.heartbeatIntervalMs);
    if (answer.drain) this.#drain("the roster already held this host in drain when it registered");
  }

  #drain(reason: string): void {
    if (this.#drained) return;
    this.#drained = true;
    this.#deps.log(`drain: ${reason}`);
    this.#deps.onDrain();
  }

  /** The plane owns the cadence; a daemon that beats faster than asked is a small DDoS. */
  #adoptInterval(publishedMs: number): void {
    if (publishedMs <= 0 || publishedMs === this.#intervalMs) return;
    this.#deps.log(`heartbeat cadence ${this.#intervalMs}ms -> ${publishedMs}ms, as published by the control plane`);
    this.#intervalMs = publishedMs;
    if (this.#timer === null) return;
    this.stop();
    this.start();
  }

  /**
   * Logged only on a TRANSITION: at one beat every five seconds a level-triggered line would be
   * 17k identical entries a day, and the thing an operator needs to see is the moment it moved.
   */
  #applyWatermark(sample: PsiSample | null): void {
    const next = watermarkFor(sample);
    if (next === this.#watermark) return;
    const detail =
      sample === null
        ? "this kernel exposes no pressure data, so the host reads as green"
        : `psi some10=${sample.some10} some60=${sample.some60} full10=${sample.full10}`;
    this.#deps.log(`host memory watermark ${this.#watermark} -> ${next} (${detail})`);
    this.#watermark = next;
  }
}
