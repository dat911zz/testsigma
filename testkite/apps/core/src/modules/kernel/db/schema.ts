/**
 * Module kernel — bảng krn_ (ownership.json).
 *
 * krn_outbox là transactional outbox: mọi gọi NGƯỢC/NGANG trên DAG module đi qua đây.
 * KHÔNG bật RLS: relay phải đọc được event của MỌI team. Thay vào đó phân quyền theo
 * role — testkite_app chỉ INSERT (không SELECT), testkite_relay đọc/ghi (Task 8).
 */
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const RELAY_ROLE = "testkite_relay" as const;
export const relayRole = pgRole(RELAY_ROLE);

export const krnOutbox = pgTable(
  "krn_outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    teamId: text("team_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("krn_outbox_ready_idx").on(t.availableAt, t.id)],
);

export const krnOutboxConsumed = pgTable(
  "krn_outbox_consumed",
  {
    outboxId: bigint("outbox_id", { mode: "bigint" })
      .notNull()
      .references(() => krnOutbox.id, { onDelete: "cascade" }),
    consumer: text("consumer").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // PK ghép: nhiều consumer độc lập cùng tiêu thụ một event, mỗi cặp đúng một lần.
    primaryKey({ name: "krn_outbox_consumed_pk", columns: [t.outboxId, t.consumer] }),
  ],
);
