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
  it("accepts a minimal case", () => {
    expect(authoredCaseSchema.parse(baseCase).id).toBe("checkout");
  });

  it("accepts a case with prereqCaseId and dataProfileId", () => {
    const r = authoredCaseSchema.safeParse({ ...baseCase, prereqCaseId: "login", dataProfileId: "p-logins" });
    expect(r.success).toBe(true);
  });

  it("accepts a step group (isStepGroup=true)", () => {
    expect(authoredCaseSchema.parse({ ...baseCase, isStepGroup: true }).isStepGroup).toBe(true);
  });

  it("rejects a case missing revisionId — no pinned revision means the run can't be reproduced", () => {
    const { revisionId: _drop, ...noRev } = baseCase;
    expect(authoredCaseSchema.safeParse(noRev).success).toBe(false);
  });

  it("accepts a case with empty steps (newly created case, the compiler will handle it)", () => {
    expect(authoredCaseSchema.safeParse({ ...baseCase, steps: [] }).success).toBe(true);
  });
});

describe("dataProfileSchema", () => {
  it("accepts a profile with the expectedToFail flag", () => {
    const parsed = dataProfileSchema.parse({
      id: "p-logins",
      rows: [{ label: "locked-user", expectedToFail: true, values: { username: "locked@shop.example.com" } }],
    });
    expect(parsed.rows[0]?.expectedToFail).toBe(true);
  });

  it("rejects a row missing expectedToFail — a silent default here is a semantic trap", () => {
    expect(dataProfileSchema.safeParse({ id: "p", rows: [{ label: "x", values: {} }] }).success).toBe(false);
  });
});

describe("envSchema", () => {
  it("accepts an env with all fields", () => {
    expect(envSchema.parse({ baseUrl: "https://shop.example.com", vars: {}, secretNames: [] }).baseUrl).toBe(
      "https://shop.example.com",
    );
  });

  it("rejects a baseUrl that isn't a URL", () => {
    expect(envSchema.safeParse({ baseUrl: "shop.example.com", vars: {}, secretNames: [] }).success).toBe(false);
  });
});

describe("compileSnapshotSchema", () => {
  it("accepts a complete snapshot", () => {
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

  it("rejects empty targetCaseIds — a run with no target is an empty run", () => {
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
