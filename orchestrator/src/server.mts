// Orchestrator 主服务
// 集成 PostgreSQL、Redis Streams 与 Worker 注册与调度
// 说明：本文件经过全面清理以修复大量 TS 语法错误与乱码注释问题

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { z } from "zod";
import dotenv from "dotenv";
import crypto from "node:crypto";

// 存储与队列适配器
import { PostgresAdapter } from "./storage/postgres.mts";
import { RedisStreamManager, RedisLockManager, RedisCancellationManager } from "./storage/redis-streams.mts";

// Worker 管理
import { WorkerRegistry } from "./worker/registry.mts";

// 中间件与工具
import { createMultiLevelRateLimit } from "./middleware/rate-limit.mts";
import { logger, requestLogger } from "./logging.mts";
// 中间件：拆分后的独立文件
import { cors } from "./middleware/cors.mts";
import { ensureContentType } from "./middleware/content-type.mts";
import { ensureAuth } from "./middleware/auth.mts";
import auth from "./api/auth.mts";
// 系统 API 路由模块（抽离）
import { registerHealthRoutes } from "./api/system/health.mts";
import { registerMetricsRoutes } from "./api/system/metrics.mts";
import { registerWorkerRoutes } from "./api/system/workers.mts";
import { registerCustomRunsRoutes } from "./api/system/runs.custom.mts";

// 原有路由（保持兼容）
import runs from "./api/runs.mts";
import threads from "./api/threads.mts";
import assistants from "./api/assistants.mts";
import store from "./api/store.mts";
import meta from "./api/meta.mts";

// 配置与环境变量解析
dotenv.config();

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
export const ServerConfigSchema = z.object({
  PORT: z.string().default("8000"),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  WORKER_JS_URL: z.string().optional(),
  WORKER_PY_URL: z.string().optional(),
  ENABLE_RATE_LIMIT: z.string().default("true"),
  ENABLE_AUTH: z.string().default("false"),
  MAX_CONNECTIONS: z.string().default("10"),
  HEALTH_CHECK_INTERVAL: z.string().default("10000"),
});

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
    await this.registerConfiguredWorkers();
    this.workerRegistry.startHealthCheck();
    serve({ fetch: this.app.fetch, port: this.config.port, hostname: this.config.host });
    logger.info(`Orchestrator started at ${this.config.host}:${this.config.port}`);
    logger.info(`Database: ${this.config.databaseUrl.replace(/\/\/.*@/, "//***@")}`);
    logger.info(`Redis: ${this.config.redisUrl.replace(/\/\/.*@/, "//***@")}`);
  }

  // 停止服务（关闭连接）
  async stop(): Promise<void> {
    this.workerRegistry.stopHealthCheck();
    try { await this.postgresAdapter.close(); } catch {}
    try { await this.redisStreamManager.close(); } catch {}
    try { await this.redisLockManager.close(); } catch {}
    try { await this.redisCancellationManager.close(); } catch {}
    logger.info("Orchestrator stopped");
  }

  // 根据环境变量注册预配置的 Worker
  private async registerConfiguredWorkers(): Promise<void> {
    const jsUrl = process.env.WORKER_JS_URL || this.config.workers.js;
    const pyUrl = process.env.WORKER_PY_URL || this.config.workers.python;
    if (jsUrl) this.workerRegistry.registerWorker({ workerId: "worker-js", workerType: "js", url: jsUrl });
    if (pyUrl) this.workerRegistry.registerWorker({ workerId: "worker-py", workerType: "python", url: pyUrl });
  }
}

// 从环境变量构建配置并运行
export function startServerFromEnv(): AgentListServer {
  const env = ServerConfigSchema.parse(process.env);
  const config: ServerConfig = {
    port: Number(env.PORT),
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    workers: { js: env.WORKER_JS_URL, python: env.WORKER_PY_URL },
    enableRateLimit: env.ENABLE_RATE_LIMIT === "true",
    enableAuth: env.ENABLE_AUTH === "true",
    maxConnections: Number(env.MAX_CONNECTIONS),
    healthCheckInterval: Number(env.HEALTH_CHECK_INTERVAL),
  };
  const server = new AgentListServer(config);
  return server;
}

// 程序入口（可用于直接启动）
export async function main(): Promise<void> {
  const server = startServerFromEnv();
  await server.start();
}

