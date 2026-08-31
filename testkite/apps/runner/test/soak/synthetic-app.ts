/**
 * The app the acceptance soak runs against, and the plan that drives it.
 *
 * A `data:` URL, deliberately: with no web server in the loop the soak measures OUR memory
 * behaviour and nothing else — no keep-alive pool, no server-side leak, no network flakiness
 * masquerading as an infra error. Its shape mirrors the workload that actually stresses the
 * fleet: a small form page whose consecutive frames are byte-identical, which is exactly what
 * the screenshot ring's dedup path sees in a real form flow.
 *
 * The plan is built by the COMPILER'S OWN `freezePlan`, not hand-written: `stepCount`,
 * `timeoutSeconds` and `contentHash` then come from the same code that produces a production
 * plan, so the soak cannot accidentally run against a plan shape the fleet would never receive.
 *
 * Case ids are real UUIDs because the wire demands it — `completedStepSchema.caseId` is
 * `z.string().uuid()`, so a friendly id like "soak-case-7" would make every `complete` a
 * 400 VALIDATION_FAILED against the contract's own schema (and against a real control plane).
 */
import { freezePlan, type CasePlan, type RunPlan, type StepPlan } from "@testkite/run-compiler";

export const SYNTHETIC_URL =
  "data:text/html,<h1 id=t>TestKite soak</h1><input id=a><input id=b><button id=go>go</button>";

/** The opKey the soak's steps carry; resolved to a navigation-only verb by the test. */
export const SOAK_OP_KEY = "soak.noop";

/** The acceptance scale (docs/SYSTEM_DESIGN.md §5 exit criteria: 200 synthetic chains). */
export const DEFAULT_SOAK_CHAINS = 200;

/** Eight steps is the mini-soak's shape, and enough that a chain opens, works and closes. */
export const SOAK_STEPS_PER_CHAIN = 8;

/** A well-formed v4 uuid carrying the chain index in its node field, so a step stays traceable. */
function soakCaseId(n: number): string {
  return `50ac0000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** What the soak reports for the milestone's exit criteria; printed as one `SOAK REPORT` line. */
export interface SoakReport {
  readonly chains: number;
  /** RSS before the first chain — reported so the one-off warm-up cost stays visible, not asserted on. */
  readonly nodeRssBootBytes: number;
  /** BASELINE: the median of the first `FLOOR_WINDOW` floors after the warm-up chain. */
  readonly nodeRssStartBytes: number;
  /** The median of the last `FLOOR_WINDOW` floors — the other end of the leak ratio. */
  readonly nodeRssEndBytes: number;
  /** The single raw RSS reading after the last browser closed and settled; reported, not asserted. */
  readonly nodeRssFinalBytes: number;
  readonly browserTreeRssPeakBytes: number;
  /** Chromium processes still alive after the last browser closed — measured AFTER a settle window. */
  readonly orphanChromiumAfter: number;
  readonly contextsLeaked: number;
  /** TREND only: this box is a shared 4-vCPU sandbox, not a fleet host. */
  readonly msPerChainP50: number;
  /** Real browser teardowns performed, driven by `browserRecycleReason`. */
  readonly recycles: number;
}

export function buildSyntheticPlan(chainCount: number, stepsPerChain: number): RunPlan {
  const steps = (): readonly StepPlan[] =>
    Array.from({ length: stepsPerChain }, (_unused, i) => ({
      kind: "action" as const,
      ordinal: i + 1,
      renderedSentence: `Click on element ${i + 1}`,
      groupPath: [],
      args: { element: i % 2 === 0 ? "#a" : "#b" },
      opKey: SOAK_OP_KEY,
    }));

  const kase = (n: number): CasePlan => ({
    caseId: soakCaseId(n),
    revisionId: "rev-soak",
    expectedToFail: false,
    steps: steps(),
  });

  return freezePlan({
    teamId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    baseUrl: SYNTHETIC_URL,
    lane: "batch",
    screenshots: "failure",
    chains: Array.from({ length: chainCount }, (_unused, n) => ({
      chainKey: `soak-chain-${n}`,
      cases: [kase(n)],
    })),
  });
}
