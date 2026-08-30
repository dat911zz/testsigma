/**
 * Pure classification of already-thrown values — no browser, no fake engine, no host feature.
 * CI proves the mapping itself completely. It does NOT prove that the executor calls this on
 * every path (Task 11, on the fake engine) nor that a real Playwright failure arrives shaped
 * the way these fixtures are shaped (Task 12, real chromium).
 */
import { AssertionFailure, FatalInfraError, RetryableInfraError } from "@testkite/contract";
import { describe, expect, it } from "vitest";
import { classifyError, StepTimeoutError } from "../../src/executor/verdict.js";

describe("classifyError", () => {
  it("classifies AssertionFailure as a VERDICT, never as an incident", () => {
    const c = classifyError(new AssertionFailure("expected 'Welcome', saw 'Error'"));
    expect(c.kind).toBe("assertion");
    expect(c.message).toContain("Welcome");
  });

  it("classifies RetryableInfraError as retryable infra and keeps its code", () => {
    const c = classifyError(new RetryableInfraError("browser_oom", "killed"));
    expect(c).toMatchObject({ kind: "retryable-infra", code: "browser_oom" });
  });

  it("classifies FatalInfraError as non-retryable infra", () => {
    expect(classifyError(new FatalInfraError("unknown plan format")).kind).toBe("fatal-infra");
  });

  it("treats a step timeout as an ASSERTION (the app hanging is a product signal, §4 taxonomy)", () => {
    const c = classifyError(new StepTimeoutError(3, 60_000));
    expect(c.kind).toBe("assertion");
    expect(c.message).toContain("step 3");
  });

  it("treats a Playwright TimeoutError as an assertion too, not an infra incident", () => {
    const err = new Error("locator.click: Timeout 15000ms exceeded.");
    err.name = "TimeoutError";
    expect(classifyError(err).kind).toBe("assertion");
  });

  it("treats an unknown non-Error throw as FATAL infra rather than guessing a verdict", () => {
    expect(classifyError("boom")).toMatchObject({ kind: "fatal-infra", code: "fatal_infra" });
  });

  it("uses the ONE retry predicate — retryable===true — and nothing else", () => {
    class Weird extends RetryableInfraError {}
    expect(classifyError(new Weird("network", "reset")).kind).toBe("retryable-infra");
  });
});
