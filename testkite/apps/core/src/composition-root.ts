/**
 * Composition root TƯỜNG MINH (~150 dòng khi hoàn thiện) — không DI container.
 *
 * Wiring theo DAG một chiều:
 *   kernel → identity, governance → verbs | elements | testdata
 *          → authoring → planning → orchestration → results
 *   edge (integrations, ai, mcp-gateway) chỉ phụ thuộc vào trong.
 *
 * Gọi ngược/ngang = domain event qua transactional outbox (krn_outbox,
 * ghi cùng transaction Postgres) → relay → BullMQ events → handler idempotent.
 * `import ... from "bullmq"` bị lint CẤM ngoài kernel/relay/dispatcher.
 */

// TODO(M1): import Fastify + đăng ký route từ facade các module theo thứ tự DAG.
export async function buildApp(): Promise<{ listen: (o: { host: string; port: number }) => Promise<void> }> {
  throw new Error("TODO(M1): wire kernel → identity → ... theo blueprint §4");
}
