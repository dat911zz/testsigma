import { describe, expect, it } from "vitest";
import { elementSchema, locatorSchema } from "./element.js";

describe("locatorSchema", () => {
  it("accepts a valid locator", () => {
    expect(locatorSchema.parse({ kind: "css", value: "#login" })).toEqual({ kind: "css", value: "#login" });
  });

  it("accepts a kind outside the familiar list (kind is a free-form string)", () => {
    expect(locatorSchema.parse({ kind: "test-id", value: "account-menu" }).kind).toBe("test-id");
  });

  it("rejects an empty kind", () => {
    expect(locatorSchema.safeParse({ kind: "", value: "#login" }).success).toBe(false);
  });
});

describe("elementSchema", () => {
  const ok = {
    id: "el-signin",
    name: "Sign in button",
    status: "ready",
    locators: [{ kind: "css", value: "#signin" }],
  };

  it("accepts a ready element", () => {
    expect(elementSchema.parse(ok).status).toBe("ready");
  });

  it("accepts a pending_locator element", () => {
    expect(elementSchema.parse({ ...ok, status: "pending_locator" }).status).toBe("pending_locator");
  });

  it("rejects an unknown status", () => {
    expect(elementSchema.safeParse({ ...ok, status: "draft" }).success).toBe(false);
  });

  it("rejects a READY element with no locator — 'ready' is a promise that phase 4 can bind it", () => {
    expect(elementSchema.safeParse({ ...ok, locators: [] }).success).toBe(false);
  });

  it("accepts a pending_locator element with NO locator yet — exactly 'not captured yet'", () => {
    // Fixture err-element-pending-locator.json (the compiler's settled contract) carries
    // exactly this shape; the compiler is the one that emits the `element_pending_locator` diagnostic.
    expect(elementSchema.safeParse({ ...ok, status: "pending_locator", locators: [] }).success).toBe(true);
  });

  it("COLLECTS every issue instead of stopping at the first error", () => {
    const r = elementSchema.safeParse({ id: "", name: "", status: "draft", locators: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});
