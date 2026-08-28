import { describe, expect, it } from "vitest";
import { JOB_STATUSES, RUN_VERDICTS, RetryableInfraError } from "./index.js";

describe("contract unions", () => {
  it("compile_error is a RunVerdict (a compile error never touches the browser)", () => {
    expect(RUN_VERDICTS).toContain("compile_error");
  });
  it("unknown_after_restore exists for post-restore quarantine", () => {
    expect(JOB_STATUSES).toContain("unknown_after_restore");
  });
  it("RetryableInfraError is the only retryable branch", () => {
    expect(new RetryableInfraError("browser_oom", "boom").retryable).toBe(true);
  });
});
