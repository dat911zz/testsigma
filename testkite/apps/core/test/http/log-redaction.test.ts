/**
 * WHAT A 500 IS ALLOWED TO WRITE INTO THE LOG.
 *
 * `installErrorHandler` logs the whole error object on any status >= 500, and pino's default
 * `err` serializer copies an Error's own enumerable properties straight out. Drizzle throws
 * `DrizzleQueryError`, which carries `query` (the full SQL) and `params` (every bound value)
 * — and, worse, builds its MESSAGE and therefore the first line of its STACK out of exactly
 * those two. So one failed INSERT into `res_case_results` used to print another tenant's
 * failure_context — screenshot paths, locators, whatever the step captured — into a log
 * stream that is shipped, indexed and read by people who are not that tenant.
 *
 * The serializer is therefore an ALLOWLIST (name/message/code/constraint/stack), walking the
 * `.cause` chain so the driver error underneath keeps saying which constraint broke. This
 * suite asserts the negative — no SQL, no bound values, in any of the three places they hide.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { installErrorHandler } from "../../src/http/errors.js";
import { LOG_SERIALIZERS, serializeLoggedError } from "../../src/http/log-serializers.js";
import { buildInternalApp } from "../../src/http/internal/app.js";
import { makeTestApp, type TestApp } from "../harness/http.js";
import { INTERNAL_TEST_ENV } from "../harness/internal.js";

/** The INSERT that actually goes wrong in production: one case result plus its context blob. */
const QUERY =
  'insert into "res_case_results" ("team_id","id","run_id","status","failure_context") ' +
  "values ($1,$2,$3,$4,$5) returning \"id\"";

const CONTEXT = JSON.stringify({
  lastLocator: "#checkout-submit",
  screenshot: "s3://tk-artifacts/acme-corp/run-9174/step-3.png",
  console: "POST /pay 500 — card_token=cus_9RtZ1aQ7hunter2",
});

const PARAMS: readonly unknown[] = [
  "8f14e45f-ceea-4c9a-a2f3-000000000001",
  "8f14e45f-ceea-4c9a-a2f3-000000000002",
  "8f14e45f-ceea-4c9a-a2f3-000000000003",
  "failed",
  CONTEXT,
];

/** Everything that must never reach the log, each one from a different hiding place. */
const SECRETS: readonly string[] = [
  "failure_context", // the SQL text
  "acme-corp", // a tenant name, inside a bound value
  "cus_9RtZ1aQ7hunter2", // a payment token, inside a bound value
  "#checkout-submit", // a locator, inside a bound value
  "8f14e45f-ceea-4c9a-a2f3-000000000003", // a bound id
];

function queryError(): DrizzleQueryError {
  // Shaped exactly like node-postgres' DatabaseError: the useful diagnostics live on the
  // CAUSE, which is why the serializer has to walk the chain instead of stopping at the top.
  const cause: Error & { code?: string; constraint?: string; detail?: string } = new Error(
    'duplicate key value violates unique constraint "case_results_exec_unique"',
  );
  cause.code = "23505";
  cause.constraint = "case_results_exec_unique";
  // pg puts the offending VALUES in `detail`. It is not on the allowlist, so it must be gone.
  cause.detail = `Key (team_id, id)=(acme-corp, ${CONTEXT}) already exists.`;
  return new DrizzleQueryError(QUERY, [...PARAMS], cause);
}

describe("log serializer — a 500 never prints the query or its bound values", () => {
  it("the raw error DOES carry all of it — otherwise this suite proves nothing", () => {
    const err = queryError();
    const raw = JSON.stringify({ message: err.message, stack: err.stack, query: err.query, params: err.params });
    for (const secret of SECRETS) expect(raw, secret).toContain(secret);
  });

  it("serializing keeps the diagnosis and drops the data", () => {
    const out = serializeLoggedError(queryError());
    const text = JSON.stringify(out);
    for (const secret of SECRETS) expect(text, `leaked: ${secret}`).not.toContain(secret);
    // What an on-call engineer actually needs is still there.
    expect(out.cause?.code).toBe("23505");
    expect(out.cause?.constraint).toBe("case_results_exec_unique");
    expect(out.stack).toContain("at ");
  });

  it("through a REAL pino, on the REAL error handler, the emitted line is clean", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: "error",
        serializers: LOG_SERIALIZERS,
        stream: {
          write: (chunk: string): void => {
            lines.push(chunk);
          },
        },
      },
    });
    installErrorHandler(app);
    app.get("/boom", async () => {
      throw queryError();
    });
    const r = await app.inject({ method: "GET", url: "/boom" });

    // The response contract does not move: still a generic 500, still a requestId.
    expect(r.statusCode).toBe(500);
    expect(r.json()).toMatchObject({ code: "INTERNAL" });

    const logged = lines.join("");
    expect(logged, "the handler did not log at all").toContain("unhandled error");
    for (const secret of SECRETS) expect(logged, `leaked: ${secret}`).not.toContain(secret);
    // Every leak of the original message — from `message` or from the stack header — starts
    // with this exact prefix, and the redaction marker deliberately shares none of it.
    expect(logged).not.toContain("Failed query:");
    expect(logged).toContain("[query redacted]");
    expect(logged).toContain("23505");
    await app.close();
  });

  it("a plain Error is untouched — redaction is for query errors, not for every message", () => {
    const out = serializeLoggedError(new Error("compile phase 4 exploded"));
    expect(out.message).toBe("compile phase 4 exploded");
    expect(out.type).toBe("Error");
  });

  it("a cause CYCLE terminates instead of hanging the logger", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(() => JSON.stringify(serializeLoggedError(a))).not.toThrow();
  });

  it("a non-Error throw is serialized without stringifying its contents", () => {
    const out = serializeLoggedError({ secret: "cus_9RtZ1aQ7hunter2" });
    expect(JSON.stringify(out)).not.toContain("cus_9RtZ1aQ7hunter2");
  });
});

describe("log serializer — both Fastify instances install it", () => {
  // Reading the serializer table back off the live pino instance: a serializer that exists
  // but was never registered redacts nothing, and that is a difference no unit test above
  // can see.
  const serializersOf = (log: unknown): Record<string, unknown> => {
    const table = (log as Record<symbol, unknown>)[Symbol.for("pino.serializers")];
    expect(table, "pino exposes no serializer table — the symbol moved").toBeTypeOf("object");
    return table as Record<string, unknown>;
  };

  let pub: TestApp;
  beforeAll(async () => {
    pub = await makeTestApp();
  });
  afterAll(async () => {
    await pub.close();
  });

  it("buildHttpApp (public /v1)", () => {
    expect(serializersOf(pub.app.log)["err"]).toBe(serializeLoggedError);
  });

  it("buildInternalApp (the fleet plane)", async () => {
    // Raised on the public suite's own database: nothing here touches a row, only the
    // logger the builder installed.
    const internal = await buildInternalApp({
      env: INTERNAL_TEST_ENV,
      db: pub.db.db,
      bootstrapTokenHash: createHash("sha256").update("bootstrap").digest(),
    });
    await internal.ready();
    expect(serializersOf(internal.log)["err"]).toBe(serializeLoggedError);
    await internal.close();
  });
});
