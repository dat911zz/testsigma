/**
 * The pool's `error` listener is the difference between "one connection died" and
 * "the whole control plane died".
 *
 * `pg.Pool` is an EventEmitter. A connection sitting IDLE in the pool can still be cut from the
 * SERVER side — a database restart, a failover, a network blip, an admin running
 * `pg_terminate_backend` — and pg-pool re-emits that connection's error ON THE POOL from its
 * idle listener. An EventEmitter with no `error` listener THROWS the error instead of emitting
 * it, which surfaces as an uncaught exception and takes the whole process down (reproduced
 * 2026-08-30 against a real cluster: "Unhandled error event", exit code 1, stack through
 * pg-pool's idleListener).
 *
 * That process also hosts the lease reaper and the outbox relay, so one transient disconnect
 * would mean no job is ever reaped again — precisely the outage the M3 reaper exists to
 * prevent. The listener therefore LOGS and SWALLOWS: the broken connection has already been
 * evicted from the pool, and the next checkout opens a fresh one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { attachPoolErrorHandler } from "../../src/modules/kernel/db/client.js";

/** Never connected to: every assertion here is about the EventEmitter, not about a server. */
const UNUSED_URL = "postgres://postgres@127.0.0.1:1/none";

describe("pg pool error handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proves the hazard: a bare pool RETHROWS an idle client error at the process", async () => {
    const pool = new pg.Pool({ connectionString: UNUSED_URL });
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).toThrow(
      /terminating connection due to administrator command/,
    );
    await pool.end();
  });

  it("swallows an idle client error instead of killing the process", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = new pg.Pool({ connectionString: UNUSED_URL });
    attachPoolErrorHandler(pool);
    expect(() => pool.emit("error", new Error("connection terminated unexpectedly"))).not.toThrow();
    await pool.end();
  });

  it("logs the error so a silent connection loss stays visible", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = new pg.Pool({ connectionString: UNUSED_URL });
    attachPoolErrorHandler(pool);
    pool.emit("error", new Error("connection terminated unexpectedly"));
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      "idle pg client error:",
      expect.stringContaining("connection terminated unexpectedly"),
    );
    await pool.end();
  });
});
