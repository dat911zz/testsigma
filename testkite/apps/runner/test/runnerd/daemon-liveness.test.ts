/**
 * SCOPE — what this file can and cannot prove.
 *
 * `daemon.test.ts` drives `Runnerd` in-process under `vi.useFakeTimers()`, which proves order,
 * payload shape and the drain state machine but is STRUCTURALLY BLIND to one thing: whether a
 * booted daemon holds the Node event loop open. Fake timers invoke callbacks directly and never
 * consult a timer handle's ref state, and vitest's own loop is held open by the runner anyway —
 * so a daemon that `unref`'d its heartbeat interval passed all sixteen of those tests while the
 * real `runnerd.service` logged "runnerd up", exited 0 within milliseconds, and never registered
 * once. (That regression is the reason this file exists.)
 *
 * So this suite spawns a REAL child process wired like `src/runnerd/main.ts` and asserts against
 * process semantics: it stays alive, it actually beats, and SIGTERM still stops it promptly. What
 * it does NOT prove is anything about the far end — the plane is faked in the harness — nor the
 * systemd unit that starts the daemon on a host (`scripts/verify-units.sh`, and a real machine).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HARNESS_PATH = fileURLToPath(new URL("./liveness-harness.ts", import.meta.url));
/** Fast enough that a handful of beats fit in the observation window below. */
const HEARTBEAT_MS = 150;
/** ~10 heartbeats: an interval that never fires is unambiguous, a slow CI box is not punished. */
const OBSERVE_MS = 1_500;
const EXIT_GRACE_MS = 5_000;

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Harness {
  readonly child: ChildProcessWithoutNullStreams;
  /** Recorded as an array rather than a nullable field so a passing test asserts on `[]`. */
  readonly exits: Exit[];
  stdout(): string;
  stderr(): string;
  beats(): number;
}

let live: Harness | null = null;

/**
 * Node resolves this repo's NodeNext `./psi.js` specifiers literally, so the harness installs a
 * resolver hook of its own; type stripping is asked for explicitly because `engines` allows Node
 * 22.15, where it is not yet on by default.
 */
function startHarness(): Harness {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", HARNESS_PATH],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TK_LIVENESS_INTERVAL_MS: String(HEARTBEAT_MS) },
    },
  );
  let out = "";
  let err = "";
  const exits: Exit[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  child.on("exit", (code, signal) => {
    exits.push({ code, signal });
  });
  const harness: Harness = {
    child,
    exits,
    stdout: () => out,
    stderr: () => err,
    beats: () => out.split("\n").filter((line) => line.startsWith("beat ")).length,
  };
  live = harness;
  return harness;
}

async function waitForExit(harness: Harness, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (harness.exits.length === 0 && Date.now() < deadline) await delay(25);
}

afterEach(async () => {
  const harness = live;
  live = null;
  if (harness === null || harness.exits.length > 0) return;
  harness.child.kill("SIGKILL");
  await waitForExit(harness, EXIT_GRACE_MS);
});

describe("runnerd process liveness", () => {
  it("keeps its own process alive and keeps heartbeating, with nothing else holding the loop open", async () => {
    const harness = startHarness();
    await delay(OBSERVE_MS);

    // The failure this catches: an `unref`'d heartbeat interval. The harness boots, prints
    // "booted", and Node finds no ref'd handle left, so it exits 0 before the first beat.
    expect(
      harness.exits,
      `runnerd exited on its own after boot — nothing kept its event loop alive.\nstdout: ${harness.stdout()}\nstderr: ${harness.stderr()}`,
    ).toEqual([]);
    expect(harness.stdout()).toContain("booted");
    expect(harness.beats(), `stdout: ${harness.stdout()}`).toBeGreaterThanOrEqual(2);
  });

  it("still exits promptly on SIGTERM, because stop() releases the interval it holds", async () => {
    const harness = startHarness();
    // Wait for evidence the daemon is up and running before asking it to go down.
    const deadline = Date.now() + OBSERVE_MS;
    while (harness.beats() === 0 && harness.exits.length === 0 && Date.now() < deadline) await delay(25);
    expect(harness.beats(), `stderr: ${harness.stderr()}`).toBeGreaterThanOrEqual(1);

    harness.child.kill("SIGTERM");
    await waitForExit(harness, EXIT_GRACE_MS);

    // A daemon whose only ref'd handle is its heartbeat must not need SIGKILL to go away.
    expect(harness.exits, `stdout: ${harness.stdout()}`).toEqual([{ code: 0, signal: null }]);
    expect(harness.stdout()).toContain("stopped");
  });
});
