/**
 * Control plane env, validated with zod, COLLECTS all errors then exit(1).
 * Never read process.env scattered across the code — use KernelEnv everywhere.
 */
import { hostname } from "node:os";
import { z } from "zod";

/**
 * Default identity of this process in the dispatcher election: `<hostname>#<pid>`.
 *
 * DELIBERATE DEVIATION from the plan's `default(hostname())`. The holder string is the WHOLE
 * identity `acquireOrRenewLease` fences on — there is no connection, session or pid behind it
 * — and the same-holder branch of the election is defined as a RENEW, not a takeover. Two
 * processes that pick the SAME string are therefore both told they lead, on every tick, with
 * an epoch that never advances for `job_runs` fencing to separate them by. That is a
 * permanent split-brain, not the brief self-correcting takeover window the dispatcher loop is
 * designed around, and it silently removes the single-writer property the reaper depends on
 * (two sweeps requeueing one team both compute MIN(queue_seq) - 1 and tie). Measured on real
 * Postgres over two independent pools: test/concurrency/dispatcher-leader.test.ts.
 *
 * The hostname alone is not unique per process: node cluster mode, `pm2 -i`, an overlapping
 * rolling deploy, or two containers sharing the host UTS namespace all put a second
 * dispatcher-capable process on one name. The pid closes that gap for free — pids are unique
 * among the LIVE processes of a host, and identity continuity across a restart buys nothing
 * here, since a restarted dispatcher must win a fresh election either way.
 *
 * `#` rather than `-` as the separator: hostnames contain `-`, so `runner-a-4242` would be
 * ambiguous in the very alert this string exists to be read in.
 */
export function defaultDispatcherId(host: string = hostname(), pid: number = process.pid): string {
  return `${host}#${String(pid)}`;
}

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("postgres://") || u.startsWith("postgresql://"), {
      message: "DATABASE_URL must be postgres:// or postgresql:// (blueprint §3: PostgreSQL 17)",
    }),
  /** Non-superuser role used by the request path — RLS only takes effect when NOT owner/superuser. */
  DATABASE_APP_ROLE: z.string().min(1).default("testkite_app"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Enable the in-process mini-IdP for dev (sandbox has no docker to run Keycloak). */
  OIDC_DEV_MOCK: z.enum(["0", "1"]).default("0"),
  /**
   * `0` on an API replica that must NOT run the dispatcher loop (a read-only pod, say).
   *
   * Deliberate deviation from the plan's `z.coerce.boolean()`: that helper is `Boolean(value)`,
   * and every non-empty string is truthy — `DISPATCHER_ENABLED=false` would have started the
   * loop anyway, silently, on exactly the replica an operator meant to keep out of the queue.
   * An explicit enum refuses anything it cannot read as on or off.
   */
  DISPATCHER_ENABLED: z
    .enum(["0", "1", "false", "true"])
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  /**
   * Identity of THIS PROCESS in the leader election. It is also what the dead-man alert
   * prints, so it must never be empty — and, per `defaultDispatcherId`, never be shared.
   */
  DISPATCHER_ID: z.string().min(1).default(defaultDispatcherId()),
  /**
   * The fleet plane (`/internal/fleet`) is a SEPARATE Fastify instance on a port of its own, so
   * these two defaults are the first line of defence around it — before any token check.
   *
   * A distinct PORT means a public ingress pointed at `PORT` can never forward to a worker
   * endpoint, whatever the path. A LOOPBACK bind means a host with no network policy at all
   * still refuses every connection from off-box. Exposing the plane beyond the host therefore
   * has to be a written decision in the deployment (`INTERNAL_HOST=0.0.0.0`), never the
   * absence of one.
   */
  INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  INTERNAL_HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * The host credential of `runnerd`, accepted by exactly ONE endpoint
   * (`POST /internal/fleet/workers/register`) and compared against its SHA-256 in constant time.
   *
   * REQUIRED, with no default, for the same reason as the S3 keys and then some: a fallback
   * value would be a shared secret published in this repository, and register is the endpoint
   * that hands out worker tokens — the credential that claims jobs of EVERY team. `min(32)`
   * because register is deliberately not rate-limited (only `claim` is, per the fleet
   * contract), so the only thing standing between a reachable port and a worker identity is
   * how expensive the token is to guess.
   */
  FLEET_BOOTSTRAP_TOKEN: z.string().min(32),
  /**
   * The artifact store. REQUIRED, with no fallback: a control plane that cannot sign an upload
   * URL accepts runs whose traces, screenshots and videos are silently dropped — a failure that
   * only becomes visible days later, when someone opens a failed run and finds nothing. Failing
   * at boot is the cheaper end of that trade.
   *
   * Only `S3_REGION` carries a default: MinIO ignores the region entirely but SigV4 still signs
   * it, so `us-east-1` is the conventional filler rather than a deployment decision.
   *
   * The scheme check is a DELIBERATE ADDITION to the plan's bare `.url()`: WHATWG accepts
   * `minio.internal:9000` as a URL whose SCHEME is `minio.internal` (measured on zod 3 —
   * `.url()` is `new URL()`), and `new URL(...).host` on that is the empty string. The presigner
   * signs the Host header, so the misconfiguration would not fail at boot at all — it would ship
   * every worker a signature for a host nobody serves. Same shape, same reason, as DATABASE_URL.
   */
  S3_ENDPOINT: z
    .string()
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "S3_ENDPOINT must be an http:// or https:// origin — SigV4 signs the host",
    }),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET_ARTIFACTS: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
});

export type KernelEnv = z.infer<typeof envSchema>;

export type ParseEnvResult =
  | { readonly ok: true; readonly env: KernelEnv }
  | { readonly ok: false; readonly issues: readonly string[] };

export function parseEnv(raw: NodeJS.ProcessEnv): ParseEnvResult {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return { ok: true, env: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): KernelEnv {
  const r = parseEnv(raw);
  if (r.ok) return r.env;
  console.error("Env configuration is INVALID — not starting:");
  for (const issue of r.issues) console.error(`  - ${issue}`);
  process.exit(1);
}
