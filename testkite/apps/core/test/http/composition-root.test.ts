/**
 * The composition root is the ONE file that decides what a running control plane actually is,
 * and nothing else in the suite exercises it: every other HTTP test builds its own app through
 * `test/harness/http.ts`. A harness that wires a route the production wiring forgot is a false
 * green of the worst kind — the whole L3 isolation suite would pass against routes no deployed
 * process serves. So this file drives `buildApp` itself.
 *
 * Three properties, all of them invisible to a unit test of the pieces:
 *  1. the fleet plane is a SEPARATE server on a SEPARATE port, and the public app does not
 *     serve `/internal/fleet` at any path;
 *  2. every descriptor in ROUTES is served by the app the production entrypoint builds;
 *  3. the dispatcher loop really starts, really takes the lease under DISPATCHER_ID, and
 *     really hands it back on `close()` — the property that turns a deploy from "the queue
 *     stalls for a lease TTL" into "the next process leads on its first tick".
 *
 * REAL Postgres, not PGlite: `buildApp` builds its own `pg.Pool` from DATABASE_URL, and the
 * dispatcher's very first act is `SET ROLE testkite_dispatch` — neither has a PGlite path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ROUTES, toFastifyPath } from "@testkite/contract";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/composition-root.js";
import { readLease } from "../../src/modules/orchestration/dispatcher/lease.js";
import type { KernelEnv } from "../../src/modules/kernel/index.js";
import type { TkApp } from "../../src/http/app.js";
import { describeRealPg, makeRealDb, realPgUrl, type RealDb } from "../harness/realpg.js";

/** Long enough for the token to be a credential rather than a formality (env.ts enforces 32). */
const BOOTSTRAP_TOKEN = "tkb_composition_root_bootstrap_secret";

/**
 * `INTERNAL_PORT: 0` asks the kernel for a free port. It is deliberately NOT reachable through
 * `parseEnv` (the schema demands 1..65535, because a production plane on a random port is a
 * plane runnerd cannot find) — this test hands `buildApp` an already-parsed `KernelEnv`, which
 * is exactly what `main.ts` does too, so nothing is bypassed except the string parsing.
 */
function testEnv(databaseUrl: string, over: Partial<KernelEnv> = {}): KernelEnv {
  return {
    NODE_ENV: "test",
    PORT: 8080,
    DATABASE_URL: databaseUrl,
    DATABASE_APP_ROLE: "testkite_app",
    DATABASE_POOL_MAX: 4,
    LOG_LEVEL: "error",
    OIDC_DEV_MOCK: "0",
    DISPATCHER_ENABLED: true,
    DISPATCHER_ID: "composition-root#1",
    INTERNAL_PORT: 0,
    INTERNAL_HOST: "127.0.0.1",
    FLEET_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    S3_ENDPOINT: "http://minio.test:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET_ARTIFACTS: "artifacts",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    ...over,
  };
}

/** The bound address of the fleet plane, or a loud failure — an unbound plane proves nothing. */
function fleetAddress(app: TkApp): AddressInfo {
  const fleet = app.tkFleet;
  if (fleet === null) throw new Error("buildApp did not wire a fleet plane onto the app");
  const address = fleet.server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`the fleet plane is not listening on a TCP port: ${String(address)}`);
  }
  return address;
}

async function until<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeRealPg("composition root", () => {
  let r: RealDb;
  const built: TkApp[] = [];

  /** Every app this file builds owns a pool and a listening socket; both die here. */
  const build = async (over: Partial<KernelEnv> = {}): Promise<TkApp> => {
    const url = realPgUrl();
    if (url === undefined) throw new Error("TESTKITE_TEST_PG_URL is not set");
    const app = await buildApp(testEnv(url, over));
    built.push(app);
    return app;
  };

  beforeAll(async () => {
    r = await makeRealDb();
  });
  afterAll(async () => {
    await r.close();
  });
  beforeEach(async () => {
    // A lease left by the previous test would make "the dispatcher took the lease" true before
    // this test's dispatcher has done anything at all.
    await r.db.execute(sql`TRUNCATE orc_dispatcher_lease`);
  });
  afterEach(async () => {
    for (const app of built.splice(0)) await app.close();
  });

  it("serves the fleet plane on its OWN port and never on the public app", async () => {
    const app = await build();
    const { port, address } = fleetAddress(app);
    expect(port).toBeGreaterThan(0);
    expect(port, "the fleet plane must not share the tenant port").not.toBe(8080);

    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // The plane is really MOUNTED there (a 404 here would mean an empty server answering
    // /healthz), and it demands a credential before it looks at anything else.
    const unauthenticated = await fetch(`http://127.0.0.1:${String(port)}/internal/fleet/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId: "w-1", lane: "batch", freeSlots: 1 }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(address).toBe("127.0.0.1");

    // ...and the tenant app knows nothing about it, with or without a bearer token: a public
    // ingress pointed at PORT can never reach a worker endpoint.
    for (const authorization of [undefined, `Bearer ${BOOTSTRAP_TOKEN}`]) {
      const leaked = await app.inject({
        method: "POST",
        url: "/internal/fleet/claim",
        ...(authorization === undefined ? {} : { headers: { authorization } }),
        payload: { workerId: "w-1", lane: "batch", freeSlots: 1 },
      });
      expect(leaked.statusCode, `/internal reachable on the public app: ${leaked.body}`).toBe(404);
    }
  });

  it("serves EVERY descriptor in ROUTES — the production wiring, not the test harness's", async () => {
    // test/isolation/cross-tenant.test.ts asserts this against `makeTestApp`. A module wired
    // into the harness and forgotten here would leave that whole suite testing routes no
    // deployed process serves.
    const app = await build();
    const live = new Set(app.tkRegisteredRoutes.map((route) => `${route.method} ${route.url}`));
    const dead = ROUTES.filter(
      (route) => !live.has(`${route.method.toUpperCase()} ${toFastifyPath(route.path)}`),
    ).map((route) => route.operationId);
    expect(dead, "descriptor in ROUTES that buildApp serves nowhere").toEqual([]);
  });

  it("starts the dispatcher, which takes the lease under DISPATCHER_ID", async () => {
    const app = await build({ DISPATCHER_ID: "composition-root#lease" });
    const lease = await until("the dispatcher to take the lease", async () => {
      const current = await readLease(r.db);
      return current !== null && current.holder === "composition-root#lease" ? current : null;
    });
    expect(lease.epoch).toBeGreaterThan(0);
    expect(lease.stale).toBe(false);
    expect(app.tkFleet).not.toBeNull();
  });

  it("hands the lease back on close, so the next process leads on its FIRST tick", async () => {
    const app = await build({ DISPATCHER_ID: "composition-root#handover" });
    await until("the dispatcher to take the lease", async () => {
      const current = await readLease(r.db);
      return current !== null && current.holder === "composition-root#handover" ? current : null;
    });

    await app.close();

    const after = await readLease(r.db);
    // Released, not deleted: the row keeps the holder that gave it up (the release is fenced on
    // (holder, epoch)), and `stale` is what the next election reads to take over immediately.
    expect(after?.holder).toBe("composition-root#handover");
    expect(after?.stale).toBe(true);
  });

  it("closing the app unbinds the fleet port", async () => {
    const app = await build();
    const { port } = fleetAddress(app);
    expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);

    await app.close();

    // A plane still bound after `close()` keeps answering workers with a control plane whose
    // database pool has already been torn down underneath it.
    await expect(fetch(`http://127.0.0.1:${String(port)}/healthz`)).rejects.toThrow();
  });

  it("runs NO dispatcher when DISPATCHER_ENABLED is off", async () => {
    // A read-only replica must not reap or dispatch. The proof is negative, so it is bounded by
    // time rather than by an event: several tick intervals (250ms each) with an untouched table.
    await build({ DISPATCHER_ENABLED: false, DISPATCHER_ID: "composition-root#disabled" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await readLease(r.db)).toBeNull();
  });
});
