// Server 主服务
// 集成 PostgreSQL、Redis Streams 与 Worker 注册与调度
// 说明：本文件经过全面清理以修复大量 TS 语法错误与乱码注释问题

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
// 环境读取逻辑已抽离到 config/env.mts
import { getEnv, buildServerConfigFromEnv } from "./config/env.mjs";
import path from "node:path";

// 存储与队列适配器
import { PostgresAdapter } from "./storage/postgres.mjs";
import {
  RedisStreamManager,
  RedisLockManager,
  RedisCancellationManager,
} from "./storage/redis-streams.mjs";

// Worker 管理
import { WorkerRegistry } from "./worker/registry.mjs";

// 中间件与工具
import { createMultiLevelRateLimit } from "./middleware/rate-limit.mjs";
import { logger, requestLogger } from "./logging.mjs";
// 中间件：拆分后的独立文件
import { cors } from "./middleware/cors.mjs";
import { ensureContentType } from "./middleware/content-type.mjs";
import { ensureAuth } from "./middleware/auth.mjs";
import auth from "./api/auth.mjs";
// 系统 API 路由模块（抽离）
import { registerHealthRoutes } from "./api/system/health.mjs";
import { registerMetricsRoutes } from "./api/system/metrics.mjs";
import { registerWorkerRoutes } from "./api/system/workers.mjs";
import { registerCustomRunsRoutes } from "./api/system/runs.custom.mjs";

// 原有路由（保持兼容）
import runs from "./api/runs.mjs";
import threads from "./api/threads.mjs";
import assistants from "./api/assistants.mjs";
import store from "./api/store.mjs";
import meta from "./api/meta.mjs";

// 环境变量读取已经移至 config/env.mts：
// 先读系统环境变量；若缺失关键项，则回退到仓库根目录 .env

// 服务器配置接口
export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  workers: { js?: string; python?: string };
  enableRateLimit: boolean;
  enableAuth: boolean;
  maxConnections: number;
  healthCheckInterval: number;
}

// 使用 zod 校验环境变量（类型安全）
// 说明：环境变量 schema 与默认值已迁移到 config/env.mts

// 主服务类
export class AgentListServer {
  private app: Hono;
  private postgresAdapter: PostgresAdapter;
  private redisStreamManager: RedisStreamManager;
  private redisLockManager: RedisLockManager;
  private redisCancellationManager: RedisCancellationManager;
  private workerRegistry: WorkerRegistry;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.app = new Hono();

    // 初始化存储适配器（连接池）
    this.postgresAdapter = new PostgresAdapter({
      connectionString: config.databaseUrl,
      maxConnections: config.maxConnections,
    });

    // 初始化 Redis 组件（队列/锁/取消）
    const redisConfig = { url: config.redisUrl };
    this.redisStreamManager = new RedisStreamManager(redisConfig);
    this.redisLockManager = new RedisLockManager(redisConfig);
    this.redisCancellationManager = new RedisCancellationManager(redisConfig);

    // 初始化 Worker 注册表与健康检查
    this.workerRegistry = new WorkerRegistry(config.healthCheckInterval);

    // 安装中间件与路由
    this.setupMiddleware();
    this.setupRoutes();
  }

  // 安装通用中间件（日志、CORS、限流、依赖注入）
  private setupMiddleware(): void {
    this.app.use("*", contextStorage());
    this.app.use("*", requestLogger());
    this.app.use("*", cors());
    this.app.use("*", ensureContentType());

    if (this.config.enableAuth) {
      this.app.use("*", ensureAuth({ exempt: ["/health", "/auth/*"] }));
    }

    if (this.config.enableRateLimit) {
      // 说明：限流复用 Redis 连接（高性能）
      const rateLimitMiddleware = createMultiLevelRateLimit(
        // @ts-expect-error 兼容内部实现：从管理器暴露 redis 实例
        this.redisStreamManager["redis"]
      );
      rateLimitMiddleware.forEach((m) => this.app.use("*", m));
    }

    // 注入依赖到请求上下文（方便各路由访问）
    this.app.use("*", async (c, next) => {
      c.set("postgres", this.postgresAdapter);
      c.set("redisStreams", this.redisStreamManager);
      c.set("redisLocks", this.redisLockManager);
      c.set("redisCancellation", this.redisCancellationManager);
      c.set("workerRegistry", this.workerRegistry);
      await next();
    });
  }

  // 注册所有路由
  private setupRoutes(): void {
    // 健康检查路由
    registerHealthRoutes(this.app);

    // Worker 管理 API
    registerWorkerRoutes(this.app);

    // 指标 API
    registerMetricsRoutes(this.app);

    // 认证路由
    this.app.route("/auth", auth);

    // 兼容原有 API 路由
    this.app.route("/assistants", assistants);
    this.app.route("/threads", threads);
    this.app.route("/runs", runs);
    this.app.route("/store", store);
    this.app.route("/", meta);

    // 自定义运行 API - 调度 Worker 并转发 SSE
    registerCustomRunsRoutes(this.app, this.config.databaseUrl);
  }

  // Worker 路由已抽到 api/system/workers.mts

  // 指标路由已抽到 api/system/metrics.mts

  // 自定义运行 API 已抽到 api/system/runs.custom.mts

  // 启动服务与健康检查
  async start(): Promise<void> {
    // 按照设计，总控启动后等待 Worker 主动注册，不再使用环境预注册
    this.workerRegistry.startHealthCheck();
    serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });
    logger.info(`Server started at ${this.config.host}:${this.config.port}`);
    logger.info(
      `Database: ${this.config.databaseUrl.replace(/\/\/.*@/, "//***@")}`
    );
    logger.info(`Redis: ${this.config.redisUrl.replace(/\/\/.*@/, "//***@")}`);
  }

  // 停止服务（关闭连接）
  async stop(): Promise<void> {
    this.workerRegistry.stopHealthCheck();
    try {
      await this.postgresAdapter.close();
    } catch {}
    try {
      await this.redisStreamManager.close();
    } catch {}
    try {
      await this.redisLockManager.close();
    } catch {}
    try {
      await this.redisCancellationManager.close();
    } catch {}
    logger.info("Server stopped");
  }

  // 已移除环境预注册逻辑：Worker 将通过 /workers/register 主动注册
}

// 从环境变量构建配置并运行
export function startServerFromEnv(): AgentListServer {
  // 读取并校验环境变量（系统优先，缺失则回退到仓库根 .env）
  const env = getEnv();
  const config: ServerConfig = buildServerConfigFromEnv(env);
  const server = new AgentListServer(config);
  return server;
}

// 程序入口（可用于直接启动）
export async function main(): Promise<void> {
  const server = startServerFromEnv();
  await server.start();
}

// 如果直接运行此文件，启动服务器（兼容 Windows 路径与 tsx）
const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const argvFileUrl = argvPath
  ? new URL(`file://${argvPath.replace(/\\/g, "/")}`).href
  : "";
if (import.meta.url === argvFileUrl) {
  main().catch((error) => {
    logger.error("Failed to start server:", error);
    process.exit(1);
  });
}
