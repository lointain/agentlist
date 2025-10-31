// 共享数据库表定义（Drizzle ORM）
// 提供给 server 与 worker-js 使用，保证表结构一致性

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

// Checkpoints：运行检查点（追加式写入）
export const checkpoints = pgTable(
  "checkpoints",
  {
    checkpoint_id: uuid("checkpoint_id").primaryKey(),
    thread_id: uuid("thread_id").notNull(),
    run_id: uuid("run_id").notNull(),
    step_index: integer("step_index").notNull().default(0),
    data: jsonb("data").$type<Record<string, any>>().notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadRunIdx: index("idx_checkpoints_thread_run").on(
      table.thread_id,
      table.run_id
    ),
  })
);

// Events：运行事件/日志（追加式写入）
export const events = pgTable(
  "events",
  {
    event_id: uuid("event_id").primaryKey(),
    run_id: uuid("run_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, any>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    runIdx: index("idx_events_run_id").on(table.run_id),
  })
);