import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultDispatcherId, parseEnv, type KernelEnv } from "./env.js";

const VALID = {
  NODE_ENV: "test",
  PORT: "8080",
  DATABASE_URL: "postgres://tk:pw@localhost:5432/testkite",
  DATABASE_APP_ROLE: "testkite_app",
  LOG_LEVEL: "info",
} satisfies NodeJS.ProcessEnv;

/** The parsed env, or a loud failure — an assertion made on a rejected parse proves nothing. */
function envOf(raw: NodeJS.ProcessEnv): KernelEnv {
  const r = parseEnv(raw);
  if (!r.ok) throw new Error(`expected a valid env, got: ${r.issues.join(" | ")}`);
  return r.env;
}

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

  it("runs the dispatcher by default, under an identity unique to THIS process", () => {
    const env = envOf(VALID);
    expect(env.DISPATCHER_ENABLED).toBe(true);
    // The holder string is the WHOLE identity the election fences on, and the same-holder
    // branch of acquireOrRenewLease is a RENEW, not a takeover: two processes that pick the
    // same string are both told they lead, on every tick, for as long as the collision lasts
    // — a permanent split-brain, with an epoch that never moves for anything downstream to
    // fence on. The hostname ALONE collides on any box running a second dispatcher-capable
    // process (node cluster, `pm2 -i`, two containers sharing the host UTS namespace), so the
    // pid belongs in the default. Proof on real Postgres:
    // test/concurrency/dispatcher-leader.test.ts.
    expect(env.DISPATCHER_ID).toBe(defaultDispatcherId());
    expect(env.DISPATCHER_ID).toContain(hostname());
    expect(env.DISPATCHER_ID).toContain(String(process.pid));
  });

  it("gives two dispatcher processes on the SAME host different default identities", () => {
    // A restart is a fresh election no matter what the identity says, so a pid — cheap, and
    // unique among the live processes of a host — is all the uniqueness this needs.
    expect(defaultDispatcherId("runner-a", 4242)).not.toBe(defaultDispatcherId("runner-a", 4243));
    // Still readable in a dead-man alert at 3am: host first, pid behind it.
    expect(defaultDispatcherId("runner-a", 4242)).toContain("runner-a");
  });

  it("lets an operator override the identity — a deployment may name its dispatchers itself", () => {
    expect(envOf({ ...VALID, DISPATCHER_ID: "dispatcher-blue" }).DISPATCHER_ID).toBe("dispatcher-blue");
  });

  it("reads DISPATCHER_ENABLED as a REAL boolean, so '0' and 'false' turn the loop off", () => {
    // z.coerce.boolean() would answer `true` for both: every non-empty string is truthy, so a
    // read-only replica told to keep its hands off the queue would quietly run a dispatcher.
    for (const off of ["0", "false"]) {
      expect(envOf({ ...VALID, DISPATCHER_ENABLED: off }).DISPATCHER_ENABLED, off).toBe(false);
    }
    for (const on of ["1", "true"]) {
      expect(envOf({ ...VALID, DISPATCHER_ENABLED: on }).DISPATCHER_ENABLED, on).toBe(true);
    }
  });

  it("refuses a DISPATCHER_ENABLED that is neither on nor off, instead of guessing", () => {
    expect(parseEnv({ ...VALID, DISPATCHER_ENABLED: "yes" }).ok).toBe(false);
    expect(parseEnv({ ...VALID, DISPATCHER_ENABLED: "" }).ok).toBe(false);
  });

  it("refuses an empty DISPATCHER_ID — an anonymous leader cannot be alerted on", () => {
    expect(parseEnv({ ...VALID, DISPATCHER_ID: "" }).ok).toBe(false);
  });
});
