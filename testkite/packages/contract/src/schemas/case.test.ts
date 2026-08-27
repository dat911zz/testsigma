import { describe, expect, it } from "vitest";
import { authoredCaseSchema, compileSnapshotSchema, dataProfileSchema, envSchema } from "./case.js";

const step = { kind: "action" as const, ordinal: 1, renderedSentence: "Click", verbOpKey: "web.click", args: {} };

const baseCase = {
  id: "checkout",
  revisionId: "rev-checkout-001",
  name: "Checkout happy path",
  isStepGroup: false,
  steps: [step],
};

describe("authoredCaseSchema", () => {
  it("nhận case tối thiểu", () => {
    expect(authoredCaseSchema.parse(baseCase).id).toBe("checkout");
  });

  it("nhận case có prereqCaseId và dataProfileId", () => {
    const r = authoredCaseSchema.safeParse({ ...baseCase, prereqCaseId: "login", dataProfileId: "p-logins" });
    expect(r.success).toBe(true);
  });

  it("nhận step group (isStepGroup=true)", () => {
    expect(authoredCaseSchema.parse({ ...baseCase, isStepGroup: true }).isStepGroup).toBe(true);
  });

  it("từ chối case thiếu revisionId — không ghim revision là không tái lập được run", () => {
    const { revisionId: _drop, ...noRev } = baseCase;
    expect(authoredCaseSchema.safeParse(noRev).success).toBe(false);
  });

  it("nhận case steps rỗng (case mới tạo, compiler sẽ xử)", () => {
    expect(authoredCaseSchema.safeParse({ ...baseCase, steps: [] }).success).toBe(true);
  });
});

describe("dataProfileSchema", () => {
  it("nhận profile có cờ expectedToFail", () => {
    const parsed = dataProfileSchema.parse({
      id: "p-logins",
      rows: [{ label: "locked-user", expectedToFail: true, values: { username: "locked@shop.example.com" } }],
    });
    expect(parsed.rows[0]?.expectedToFail).toBe(true);
  });

  it("từ chối row thiếu expectedToFail — mặc định im lặng ở đây là bẫy ngữ nghĩa", () => {
    expect(dataProfileSchema.safeParse({ id: "p", rows: [{ label: "x", values: {} }] }).success).toBe(false);
  });
});

describe("envSchema", () => {
  it("nhận env đủ trường", () => {
    expect(envSchema.parse({ baseUrl: "https://shop.example.com", vars: {}, secretNames: [] }).baseUrl).toBe(
      "https://shop.example.com",
    );
  });

  it("từ chối baseUrl không phải URL", () => {
    expect(envSchema.safeParse({ baseUrl: "shop.example.com", vars: {}, secretNames: [] }).success).toBe(false);
  });
});

describe("compileSnapshotSchema", () => {
  it("nhận snapshot đầy đủ", () => {
    const r = compileSnapshotSchema.safeParse({
      teamId: "team-acme",
      projectId: "proj-web-checkout",
      targetCaseIds: ["checkout"],
      cases: { checkout: baseCase },
      elements: {},
      dataProfiles: {},
      env: { baseUrl: "https://shop.example.com", vars: {}, secretNames: [] },
    });
    expect(r.success).toBe(true);
  });

  it("từ chối targetCaseIds rỗng — run không target là run rỗng", () => {
    const r = compileSnapshotSchema.safeParse({
      teamId: "t",
      projectId: "p",
      targetCaseIds: [],
      cases: {},
      elements: {},
      dataProfiles: {},
      env: { baseUrl: "https://x.example.com", vars: {}, secretNames: [] },
    });
    expect(r.success).toBe(false);
  });
});
