// Drizzle ORM 的 Postgres 表定义
// 注意：与现有 SQL 查询字段保持一致，避免破坏当前逻辑
import {
  pgTable,
  text,
  uuid,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  checkpoints as sharedCheckpoints,
  events as sharedEvents,
} from "../../packages/shared-schema/src/index.mts";

// Assistants：助手定义，绑定到具体 graph
export const assistants = pgTable("assistants", {
  id: uuid("id").primaryKey(),
  graph_id: text("graph_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  config: jsonb("config").$type<Record<string, any>>().notNull().default({}),
  metadata: jsonb("metadata")
    .$type<Record<string, any>>()
    .notNull()
    .default({}),
  created_at: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Threads：运行线程上下文
export const threads = pgTable(
  "threads",
  {
    thread_id: uuid("thread_id").primaryKey(),
    status: text("status").notNull().default("idle"),
    config: jsonb("config").$type<Record<string, any>>().notNull().default({}),
    metadata: jsonb("metadata")
      .$type<Record<string, any>>()
      .notNull()
      .default({}),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    statusIdx: index("idx_threads_status").on(table.status),
  })
);

// Runs：任务队列记录
export const runs = pgTable(
  "runs",
  {
    run_id: uuid("run_id").primaryKey(),
    thread_id: uuid("thread_id").notNull(),
    assistant_id: uuid("assistant_id").notNull(),
    status: text("status").notNull().default("pending"),
    kwargs: jsonb("kwargs").$type<Record<string, any>>().notNull().default({}),
    metadata: jsonb("metadata")
      .$type<Record<string, any>>()
      .notNull()
      .default({}),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    started_at: timestamp("started_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    threadIdx: index("idx_runs_thread_id").on(table.thread_id),
    statusIdx: index("idx_runs_status").on(table.status),
    scheduledIdx: index("idx_runs_scheduled_at").on(table.scheduled_at),
  })
);

// Checkpoints：运行检查点，用于恢复与回溯
export const checkpoints = sharedCheckpoints;

// Events：运行事件/日志（可选持久化）
export const events = sharedEvents;

// Workers：工作者注册表（可选）
export const workers = pgTable(
  "workers",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    language: text("language").notNull().default("js"),
    capacity: integer("capacity").notNull().default(1),
    status: text("status").notNull().default("active"),
    last_heartbeat: timestamp("last_heartbeat", { withTimezone: true }),
    metrics: jsonb("metrics")
      .$type<Record<string, any>>()
      .notNull()
      .default({}),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    statusIdx: index("idx_workers_status").on(table.status),
  })
);

// Store：KV 存储（可选）
export const store = pgTable("store", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, any>>().notNull().default({}),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Users：用户账户
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username"),
    password_hash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata")
      .$type<Record<string, any>>()
      .notNull()
      .default({}),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("ux_users_email").on(table.email),
    usernameIdx: index("idx_users_username").on(table.username),
  })
);

// Roles：角色定义
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("ux_roles_name").on(table.name),
  })
);

// Permissions：权限定义
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("ux_permissions_name").on(table.name),
  })
);

// UserRoles：用户-角色映射
export const user_roles = pgTable(
  "user_roles",
  {
    user_id: uuid("user_id").notNull(),
    role_id: uuid("role_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdx: index("idx_user_roles_user").on(table.user_id),
    roleIdx: index("idx_user_roles_role").on(table.role_id),
  })
);

// RolePermissions：角色-权限映射
export const role_permissions = pgTable(
  "role_permissions",
  {
    role_id: uuid("role_id").notNull(),
    permission_id: uuid("permission_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    roleIdx: index("idx_role_permissions_role").on(table.role_id),
    permIdx: index("idx_role_permissions_perm").on(table.permission_id),
  })
);

// Sessions：会话/令牌
export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    user_id: uuid("user_id").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdx: index("idx_sessions_user").on(table.user_id),
    expiresIdx: index("idx_sessions_expires").on(table.expires_at),
  })
);
