/**
 * Graceful shutdown is what makes the composition root's `onClose` hook mean anything.
 *
 * The hook releases the dispatcher lease and unbinds the fleet plane — but a process killed
 * by an unhandled SIGTERM (every rolling deploy, every `docker stop`, every k8s eviction) never
 * runs it. The lease then sits there until its TTL expires, and for that whole window the fleet
 * has no dispatcher: nothing reaps a dead worker's lease, nothing leaves the queue. This is the
 * difference between "the next replica leads on its first tick" and "the queue stalls on every
 * deploy", so it is tested rather than assumed.
 *
 * The signal source, the exit and the logger are all injected: a test that really installed a
 * `process.once("SIGTERM")` handler and really called `process.exit` would take the vitest
 * worker with it.
 */
import { describe, expect, it, vi } from "vitest";
import { installShutdownHandlers, SHUTDOWN_SIGNALS, type ShutdownSignal } from "../../src/http/shutdown.js";

/** A fake signal source: collects handlers so a test can raise a signal by calling them. */
function harness(close: () => Promise<void>) {
  const handlers = new Map<ShutdownSignal, () => void>();
  const exits: number[] = [];
  const logs: { readonly message: string; readonly cause: unknown }[] = [];
  installShutdownHandlers({
    close,
    onSignal: (signal, handler) => handlers.set(signal, handler),
    exit: (code) => exits.push(code),
    log: (message, cause) => logs.push({ message, cause }),
  });
  const raise = async (signal: ShutdownSignal): Promise<void> => {
    const handler = handlers.get(signal);
    if (handler === undefined) throw new Error(`no handler installed for ${signal}`);
    handler();
    // The handler is synchronous by necessity (a signal listener cannot be awaited), so the
    // close it starts settles on a later microtask turn.
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0));
  };
  return { handlers, exits, logs, raise };
}

describe("installShutdownHandlers", () => {
  it("listens for both signals an orchestrator actually sends", () => {
    // SIGTERM is the deploy/eviction path; SIGINT is Ctrl-C in development. A process that
    // only handles one of them leaks a lease on the other.
    const h = harness(async () => undefined);
    expect([...h.handlers.keys()].sort()).toEqual([...SHUTDOWN_SIGNALS].sort());
  });

  it("closes the app, THEN exits 0", async () => {
    const order: string[] = [];
    const h = harness(async () => {
      order.push("closed");
    });
    await h.raise("SIGTERM");
    expect(order).toEqual(["closed"]);
    expect(h.exits).toEqual([0]);
    expect(h.logs).toEqual([]);
  });

  it("still exits — with code 1, and a log — when close fails", async () => {
    // A close that throws must not leave the process alive and unresponsive: the orchestrator
    // would wait out its whole termination grace period before sending SIGKILL.
    const boom = new Error("pool already ended");
    const h = harness(async () => {
      throw boom;
    });
    await h.raise("SIGINT");
    expect(h.exits).toEqual([1]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]?.cause).toBe(boom);
  });

  it("ignores a second signal while the first shutdown is still draining", async () => {
    // An impatient operator pressing Ctrl-C twice, or SIGTERM followed by SIGINT, would
    // otherwise call `app.close()` a second time — which ends the pg pool twice and turns a
    // clean shutdown into a crash on the way out.
    let closes = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => {
      closes += 1;
      await gate;
    });

    const first = h.raise("SIGTERM");
    const second = h.handlers.get("SIGINT");
    if (second === undefined) throw new Error("no SIGINT handler");
    second();
    expect(closes).toBe(1);

    release();
    await first;
    expect(closes).toBe(1);
    expect(h.exits).toEqual([0]);
  });
});
