/**
 * Turns a termination signal into `app.close()` — which is what actually runs the composition
 * root's `onClose` hook: stop the dispatcher (releasing its lease), unbind the fleet plane,
 * end the database pool.
 *
 * Without this, none of that happens on a deploy. Node's default action for SIGTERM is to
 * terminate immediately, so a rolling restart leaves the dispatcher lease held by a process
 * that no longer exists, and the fleet goes without a dispatcher until the TTL expires — no
 * reaping of dead workers, nothing leaving the queue — on EVERY deploy.
 *
 * Everything the outside world provides is injected. A unit test that installed a real
 * `process.once("SIGTERM")` and called the real `process.exit` would take its vitest worker
 * down with it; the shell tier is also the only tier allowed to know about `process` at all.
 */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface ShutdownDeps {
  /** Usually `() => app.close()`. Runs every `onClose` hook the app has registered. */
  readonly close: () => Promise<void>;
  readonly onSignal: (signal: ShutdownSignal, handler: () => void) => void;
  readonly exit: (code: number) => void;
  readonly log: (message: string, cause: unknown) => void;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  let draining = false;

  const shutdown = (): void => {
    // A second signal during the drain (SIGTERM then an impatient Ctrl-C) must not start a
    // second close: ending the same pg pool twice throws, turning a clean shutdown into a
    // crash on the way out — and the exit code is what an orchestrator records as the outcome.
    if (draining) return;
    draining = true;
    // A signal listener cannot be awaited, so the close runs as a detached promise whose BOTH
    // outcomes end in `exit`. A close that hangs without settling is the one case left, and it
    // ends the same way it would have without this handler at all: the orchestrator's
    // termination grace period expires and SIGKILL arrives.
    void deps.close().then(
      () => deps.exit(0),
      (err: unknown) => {
        deps.log("shutdown: closing the app failed", err);
        deps.exit(1);
      },
    );
  };

  for (const signal of SHUTDOWN_SIGNALS) deps.onSignal(signal, shutdown);
}
