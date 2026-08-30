/**
 * Shedding (docs/SYSTEM_DESIGN.md §5): 75% stop admitting, 85% abort the largest context,
 * 92% fail the youngest. A pure function of (used, limit, contexts) — the decision is testable
 * without a browser, and the worker only executes what this returns.
 *
 * Why largest at 85 and youngest at 92: at 85 the goal is to free the most memory per casualty,
 * at 92 the goal is to survive, so we throw away the least amount of already-done work.
 */
import { MEMORY } from "../memory-governance.js";

const [STOP_PCT, ABORT_PCT, FAIL_PCT] = MEMORY.shedThresholdsPct;

export type ShedLevel = "green" | "stop-admitting" | "abort-largest" | "fail-youngest";

export interface ShedCandidate {
  readonly contextId: string;
  readonly rssBytes: number;
  readonly startedAtMs: number;
}

export interface ShedAction {
  readonly level: ShedLevel;
  readonly admit: boolean;
  readonly abortContextIds: readonly string[];
}

export function shedLevel(usedBytes: number, limitBytes: number): ShedLevel {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return "green";
  const used = (usedBytes / limitBytes) * 100;
  if (used >= FAIL_PCT) return "fail-youngest";
  if (used >= ABORT_PCT) return "abort-largest";
  if (used >= STOP_PCT) return "stop-admitting";
  return "green";
}

export function planShedding(
  usedBytes: number,
  limitBytes: number,
  contexts: readonly ShedCandidate[],
): ShedAction {
  const level = shedLevel(usedBytes, limitBytes);
  if (level === "green") return { level, admit: true, abortContextIds: [] };
  if (level === "stop-admitting") return { level, admit: false, abortContextIds: [] };

  const pick =
    level === "abort-largest"
      ? [...contexts].sort((a, b) => b.rssBytes - a.rssBytes)[0]
      : [...contexts].sort((a, b) => b.startedAtMs - a.startedAtMs)[0];

  return { level, admit: false, abortContextIds: pick === undefined ? [] : [pick.contextId] };
}
