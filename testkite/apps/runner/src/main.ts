/**
 * @testkite/runner — worker container: queue consumer × Playwright chromium-headless-shell.
 *
 * INVARIANTS (docs/SYSTEM_DESIGN.md §5):
 *  - The worker holds NO DB / object-store credential: the plan and secret refs are resolved
 *    over the internal HTTP plane with a run-scoped token; artifacts go up via presigned PUT.
 *  - AssertionFailure ⇒ the job COMPLETES with verdict=failed. Only RetryableInfraError retries.
 *  - Every /fleet mutation carries lease_epoch — a stale epoch gets 409 STALE_EPOCH, so a zombie
 *    can never write a verdict.
 *  - 1 context = 1 chain, closed in `finally`. A login session flows naturally inside the context.
 */
import { loadRunnerConfig } from "./config.js";
import { MEMORY } from "./memory-governance.js";

async function main(): Promise<void> {
  // Fail fast and loudly on a bad environment: a worker that boots with a half-valid config is
  // worse than one that never boots — systemd restarts it, and the unit log names the field.
  const config = loadRunnerConfig(process.env);
  // TODO(M3):
  //  1. Register with the control plane, receive the worker id + lane (interactive|batch).
  //  2. Start one long-lived chromium-headless-shell browser inside a nested cgroup
  //     (memory.max = container − 400MB; oom_score_adj: node −500, chromium +500).
  //  3. Claim loop with concurrency = config.maxContexts; a claim is a conditional UPDATE that
  //     bumps lease_epoch (through the internal plane), 0 rows = no job.
  //  4. Poll each context's RSS every 5s (soft/hard from MEMORY); read memory.events after a
  //     kernel kill to self-diagnose and report infra-error{browser_oom, epoch, peakRss}.
  //  5. Recycle the browser per MEMORY.recycle; shed at 75/85/92%.
  console.log("testkite runner scaffold", { config, MEMORY });
  throw new Error("TODO(M3): worker loop — fleet track of the roadmap");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
