import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const VALID = {
  NODE_ENV: "test",
  PORT: "8080",
  DATABASE_URL: "postgres://tk:pw@localhost:5432/testkite",
  DATABASE_APP_ROLE: "testkite_app",
  LOG_LEVEL: "info",
} satisfies NodeJS.ProcessEnv;

describe("parseEnv", () => {
  it("accepts a valid env and coerces PORT to a number", () => {
    const r = parseEnv(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.env.PORT).toBe(8080);
    expect(r.env.NODE_ENV).toBe("test");
    expect(r.env.DATABASE_APP_ROLE).toBe("testkite_app");
  });

  it("defaults PORT=8080, LOG_LEVEL=info, DATABASE_APP_ROLE=testkite_app", () => {
    const r = parseEnv({ NODE_ENV: "test", DATABASE_URL: VALID.DATABASE_URL });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.env.PORT).toBe(8080);
    expect(r.env.LOG_LEVEL).toBe("info");
    expect(r.env.DATABASE_APP_ROLE).toBe("testkite_app");
  });

  it("COLLECTS all errors, not first-fail", () => {
    const r = parseEnv({ NODE_ENV: "banana", PORT: "not-a-port" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // missing DATABASE_URL + bad NODE_ENV + bad PORT = 3 issues
    expect(r.issues.length).toBe(3);
    expect(r.issues.join("\n")).toContain("DATABASE_URL");
    expect(r.issues.join("\n")).toContain("NODE_ENV");
    expect(r.issues.join("\n")).toContain("PORT");
  });

  it("rejects a DATABASE_URL that isn't postgres", () => {
    const r = parseEnv({ ...VALID, DATABASE_URL: "mysql://x/y" });
    expect(r.ok).toBe(false);
  });

  it("rejects PORT outside 1..65535", () => {
    expect(parseEnv({ ...VALID, PORT: "0" }).ok).toBe(false);
    expect(parseEnv({ ...VALID, PORT: "70000" }).ok).toBe(false);
  });
});
