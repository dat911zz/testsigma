/**
 * Control plane env, validated with zod, COLLECTS all errors then exit(1).
 * Never read process.env scattered across the code — use KernelEnv everywhere.
 */
import { z } from "zod";

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
