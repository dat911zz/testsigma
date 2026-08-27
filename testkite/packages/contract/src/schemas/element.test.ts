import { describe, expect, it } from "vitest";
import { elementSchema, locatorSchema } from "./element.js";

describe("locatorSchema", () => {
  it("nhận locator hợp lệ", () => {
    expect(locatorSchema.parse({ kind: "css", value: "#login" })).toEqual({ kind: "css", value: "#login" });
  });

  it("nhận kind ngoài danh sách quen thuộc (kind là chuỗi tự do)", () => {
    expect(locatorSchema.parse({ kind: "test-id", value: "account-menu" }).kind).toBe("test-id");
  });

  it("từ chối kind rỗng", () => {
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

  it("nhận element ready", () => {
    expect(elementSchema.parse(ok).status).toBe("ready");
  });

  it("nhận element pending_locator", () => {
    expect(elementSchema.parse({ ...ok, status: "pending_locator" }).status).toBe("pending_locator");
  });

  it("từ chối status lạ", () => {
    expect(elementSchema.safeParse({ ...ok, status: "draft" }).success).toBe(false);
  });

  it("từ chối element READY mà không locator — 'ready' là lời hứa bind được ở phase 4", () => {
    expect(elementSchema.safeParse({ ...ok, locators: [] }).success).toBe(false);
  });

  it("nhận element pending_locator CHƯA có locator nào — đúng nghĩa 'chưa chụp được'", () => {
    // Fixture err-element-pending-locator.json (hợp đồng đã chốt của compiler) mang
    // đúng hình dạng này; compiler mới là bên phát diagnostic `element_pending_locator`.
    expect(elementSchema.safeParse({ ...ok, status: "pending_locator", locators: [] }).success).toBe(true);
  });

  it("GOM mọi issue chứ không dừng ở lỗi đầu", () => {
    const r = elementSchema.safeParse({ id: "", name: "", status: "draft", locators: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});
