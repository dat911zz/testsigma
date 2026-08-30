/**
 * ONE predicate gates every retry in the system: `err instanceof AppError && err.retryable`.
 * This file is the single place raw throws are turned into that decision.
 *
 * The load-bearing rule (docs/SYSTEM_DESIGN.md §4): an AssertionFailure is a VERDICT, not an
 * incident. Retrying a verdict poisons result data — the run would flip from failed to passed
 * because a flaky retry got lucky, and the team would stop trusting the whole product. A hanging
 * app is the same thing: `failed(timeout)` is a product signal, not a fleet incident.
 *
 * SCOPE — CI proves this mapping end to end, because it is a pure function over values that are
 * already thrown. It does NOT prove that the executor routes every throw through here (Task 11,
 * on the fake engine) nor that a real chromium failure arrives shaped like these fixtures —
 * notably that Playwright still names its timeout `TimeoutError` (Task 12, real browser).
 */
import { AppError, AssertionFailure } from "@testkite/contract";

export class StepTimeoutError extends Error {
  readonly stepOrdinal: number;
  constructor(stepOrdinal: number, budgetMs: number) {
    super(`step ${stepOrdinal} exceeded its ${budgetMs}ms budget`);
    this.name = "StepTimeoutError";
    this.stepOrdinal = stepOrdinal;
  }
}

export type ErrorClass =
  | { readonly kind: "assertion"; readonly message: string }
  | { readonly kind: "retryable-infra"; readonly code: string; readonly message: string }
  | { readonly kind: "fatal-infra"; readonly code: string; readonly message: string };

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof AssertionFailure) return { kind: "assertion", message: err.message };
  if (err instanceof StepTimeoutError) return { kind: "assertion", message: err.message };
  if (err instanceof Error && err.name === "TimeoutError") return { kind: "assertion", message: err.message };
  if (err instanceof AppError) {
    return err.retryable
      ? { kind: "retryable-infra", code: err.code, message: err.message }
      : { kind: "fatal-infra", code: err.code, message: err.message };
  }
  return {
    kind: "fatal-infra",
    code: "fatal_infra",
    message: err instanceof Error ? err.message : `non-Error thrown: ${String(err)}`,
  };
}
