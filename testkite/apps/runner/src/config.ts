/**
 * Worker environment — validated once at boot, exit on invalid.
 *
 * The worker is ZERO-CREDENTIAL (docs/SYSTEM_DESIGN.md §5): there is deliberately NO
 * database url, NO object-store key and NO team secret in this schema. The only secret it
 * holds is the host bootstrap token used to register; everything else arrives per run from
 * the control plane and dies with the job.
 *
 * The schema is also deliberately NOT the place to tune memory: slot count and the container
 * ceiling are DERIVED from `MEMORY` (the single source of truth for the four ceilings), so a
 * hand-set env var can never put a worker's admission control out of step with the cgroup
 * limit its container was actually started with.
 */
import { z } from "zod";
import { MEMORY } from "./memory-governance.js";

const schema = z.object({
  RUNNER_LANE: z.enum(["interactive", "batch"]),
  RUNNER_WORKER_NAME: z.string().min(1),
  CONTROL_PLANE_URL: z.string().url(),
  RUNNER_BOOTSTRAP_TOKEN: z.string().min(1),
  RUNNER_WORKSPACE_DIR: z.string().min(1),
  RUNNER_CLAIM_IDLE_MS: z.coerce.number().int().positive().default(1_000),
  RUNNER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
});

export interface RunnerConfig {
  readonly lane: "interactive" | "batch";
  readonly workerName: string;
  readonly controlPlaneUrl: string;
  readonly bootstrapToken: string;
  readonly workspaceDir: string;
  readonly claimIdleMs: number;
  readonly heartbeatIntervalMs: number;
  /** Slots served concurrently by this worker — derived from the lane, never hand-tuned. */
  readonly maxContexts: number;
  readonly containerLimitBytes: number;
}

export function loadRunnerConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RunnerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid runner environment — ${issues}`);
  }
  const e = parsed.data;
  return {
    lane: e.RUNNER_LANE,
    workerName: e.RUNNER_WORKER_NAME,
    controlPlaneUrl: e.CONTROL_PLANE_URL,
    bootstrapToken: e.RUNNER_BOOTSTRAP_TOKEN,
    workspaceDir: e.RUNNER_WORKSPACE_DIR,
    claimIdleMs: e.RUNNER_CLAIM_IDLE_MS,
    heartbeatIntervalMs: e.RUNNER_HEARTBEAT_INTERVAL_MS,
    maxContexts: MEMORY.contextsPerWorker[e.RUNNER_LANE],
    containerLimitBytes: MEMORY.containerLimitMb[e.RUNNER_LANE] * 1024 * 1024,
  };
}
