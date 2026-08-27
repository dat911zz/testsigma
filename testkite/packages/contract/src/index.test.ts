import { describe, expect, it } from "vitest";
import { JOB_STATUSES, RUN_VERDICTS, RetryableInfraError } from "./index.js";

describe("contract unions", () => {
  it("compile_error là một RunVerdict (lỗi biên dịch không bao giờ chạm browser)", () => {
    expect(RUN_VERDICTS).toContain("compile_error");
  });
  it("unknown_after_restore tồn tại cho quarantine sau restore", () => {
    expect(JOB_STATUSES).toContain("unknown_after_restore");
  });
  it("RetryableInfraError là nhánh retry duy nhất", () => {
    expect(new RetryableInfraError("browser_oom", "boom").retryable).toBe(true);
  });
});
