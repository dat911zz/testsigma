/**
 * The `err` log serializer both Fastify instances install (public /v1 and the fleet plane).
 *
 * WHY IT EXISTS: `installErrorHandler` logs the whole error object on any status >= 500, and
 * pino's default `err` serializer copies an Error's own enumerable properties into the line.
 * Drizzle's `DrizzleQueryError` carries `query` — the full SQL — and `params`, every bound
 * value, which for a failed write to `res_case_results` means one tenant's
 * `failure_context`: locators, screenshot URLs, whatever the step captured. That goes into a
 * log stream that is shipped, indexed and read by people who are not that tenant. Note this
 * is not a leak to the CLIENT (the response has always been a generic 500); it is a leak
 * across the tenant boundary INSIDE our own observability plane, which is the boundary
 * blueprint §3 says we hold.
 *
 * SO IT IS AN ALLOWLIST, not a denylist: `name`/`message`/`code`/`constraint`/`stack` survive
 * and everything else is dropped, `query`, `params` and pg's `detail` (which quotes the
 * offending VALUES verbatim) included. A denylist would have to be extended every time a
 * driver adds a field, and the cost of missing one is silent.
 *
 * THREE PLACES THE QUERY HIDES, and they are why dropping two properties is not enough:
 *   1. `err.query` / `err.params` — the obvious pair,
 *   2. `err.message`, because DrizzleQueryError BUILDS it as `Failed query: <sql>\nparams: <values>`,
 *   3. `err.stack`, whose first line is that same message.
 * Cases 2 and 3 are replaced by a constant when the error carries a `query`; the driver error
 * underneath keeps its own message through `cause`, so "which constraint broke" survives.
 */

/** Everything a 500 is allowed to say about itself. Anything not here is dropped, not masked. */
export type SerializedError = {
  readonly type: string;
  readonly message: string;
  /**
   * Required, not optional: Fastify types `serializers.err` as returning `{ type, message,
   * stack }` with all three present, and an optional `stack` silently pushes the whole
   * `Fastify()` call onto its http2 overload — which then fails with a dozen errors about
   * `Http2SecureServer`, none of which mention the logger. An error with no stack gets `""`.
   */
  readonly stack: string;
  readonly code?: string;
  readonly constraint?: string;
  readonly cause?: SerializedError;
};

/**
 * Deliberately shares NO prefix with DrizzleQueryError's own `Failed query: …`: a test that
 * asserts the log never contains that prefix would otherwise be satisfied by the redaction
 * marker itself, and would stop catching a real leak.
 */
const REDACTED = "[query redacted]";
/** A `.cause` chain can be a CYCLE (`a.cause = b; b.cause = a`). A logger must not hang on one. */
const MAX_CAUSE_DEPTH = 4;

/** Reads an own property as `unknown` — drivers hang `code`/`constraint`/`query` there. */
function ownValue(target: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

/** A short scalar field, or nothing. pg sends `code` as a string; other drivers use numbers. */
function scalarField(err: object, key: string): string | undefined {
  const value = ownValue(err, key);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** The `    at …` frames only — i.e. the stack minus its `<name>: <message>` header. */
function stackFrames(stack: string): string {
  const at = stack.indexOf("\n    at ");
  return at === -1 ? "" : stack.slice(at);
}

export function serializeLoggedError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    // A thrown non-Error is a value of unknown provenance. Its SHAPE is worth logging, its
    // CONTENT is not, so it is never stringified — `[object Object]` says enough to find the
    // throw site, and cannot carry a row with it. A thrown string is its own message and is
    // kept, exactly as `Error.message` is.
    if (typeof err === "string") return { type: "string", message: err, stack: "" };
    return { type: typeof err, message: Object.prototype.toString.call(err), stack: "" };
  }
  // Carrying a `query` is what makes an error a query error — structural rather than
  // `instanceof`, so a re-thrown or cross-realm copy is redacted just the same.
  const redact = typeof ownValue(err, "query") === "string";
  const code = scalarField(err, "code");
  const constraint = scalarField(err, "constraint");
  const { cause } = err;
  const stack = err.stack ?? "";
  return {
    type: err.constructor.name,
    message: redact ? REDACTED : err.message,
    stack: redact ? `${err.name}: ${REDACTED}${stackFrames(stack)}` : stack,
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(cause === undefined || cause === null || depth >= MAX_CAUSE_DEPTH
      ? {}
      : { cause: serializeLoggedError(cause, depth + 1) }),
  };
}

/**
 * Handed to Fastify's `logger.serializers` by BOTH app builders. One shared object rather than
 * a literal per builder: two copies is how one of the two planes quietly keeps the old
 * behaviour after somebody edits the other.
 */
export const LOG_SERIALIZERS = { err: serializeLoggedError };
