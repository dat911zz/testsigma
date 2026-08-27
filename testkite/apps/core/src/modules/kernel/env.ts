/**
 * Env của control plane, validate bằng zod, GOM mọi lỗi rồi exit(1).
 * Không bao giờ đọc process.env rải rác trong code — mọi nơi dùng KernelEnv.
 */
import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("postgres://") || u.startsWith("postgresql://"), {
      message: "DATABASE_URL phải là postgres:// hoặc postgresql:// (blueprint §3: PostgreSQL 17)",
    }),
  /** Role non-superuser mà request-path dùng — RLS chỉ có hiệu lực khi KHÔNG phải owner/superuser. */
  DATABASE_APP_ROLE: z.string().min(1).default("testkite_app"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
  console.error("Cấu hình env KHÔNG hợp lệ — không khởi động:");
  for (const issue of r.issues) console.error(`  - ${issue}`);
  process.exit(1);
}
