/**
 * The decision that switches the whole `test/concurrency` layer on or off, tested on its own.
 *
 * `describeRealPg` is a module-level constant: whatever it decided is baked in before any test
 * runs, and a wrong decision shows up as the WORD "skipped" in a green report — the single
 * cheapest way for a lock-contention suite to stop existing without anyone noticing. So the
 * decision is a pure function of the environment, and this file is the only place it is
 * exercised against an environment that is not the current process's.
 *
 * The third case is the one that exists because of a real near-miss: CI sets
 * TESTKITE_REQUIRE_PG=1, so a lost or misspelled TESTKITE_TEST_PG_URL is a LOUD failure there
 * instead of a silent skip, while a dev box that never sets either variable still gets a green
 * `pnpm test` without a Postgres installed.
 */
import { describe, expect, it } from "vitest";
import { resolveRealPgMode } from "./realpg.js";

const URL = "postgres://postgres@127.0.0.1:55432/postgres";

describe("resolveRealPgMode", () => {
  it("runs the suite when Postgres is required AND its URL is present", () => {
    expect(resolveRealPgMode({ TESTKITE_REQUIRE_PG: "1", TESTKITE_TEST_PG_URL: URL })).toBe("run");
  });

  it("runs the suite on a URL alone — a dev box with Postgres never has to opt in twice", () => {
    expect(resolveRealPgMode({ TESTKITE_TEST_PG_URL: URL })).toBe("run");
  });

  it("skips when nothing is required and no URL is set — the plain dev-box case", () => {
    expect(resolveRealPgMode({})).toBe("skip");
  });

  it("THROWS when Postgres is required but the URL is missing, instead of skipping quietly", () => {
    expect(() => resolveRealPgMode({ TESTKITE_REQUIRE_PG: "1" })).toThrow(
      /TESTKITE_REQUIRE_PG=1.*TESTKITE_TEST_PG_URL/s,
    );
  });

  it("treats an EMPTY url as missing — `eval $(test-pg.sh start)` that failed exports nothing", () => {
    // The exact shape of the near-miss: a non-idempotent `start` prints no URL, `eval` of an
    // empty string still exits 0, and the variable ends up set-but-empty rather than unset.
    expect(() =>
      resolveRealPgMode({ TESTKITE_REQUIRE_PG: "1", TESTKITE_TEST_PG_URL: "" }),
    ).toThrow(/TESTKITE_TEST_PG_URL/);
    expect(resolveRealPgMode({ TESTKITE_TEST_PG_URL: "" })).toBe("skip");
  });
});
