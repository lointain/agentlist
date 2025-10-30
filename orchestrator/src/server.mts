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
    // 健康检查
    this.app.get("/health", async (c) => {
      try {
        await this.postgresAdapter.runs.search({ limit: 1 });
        // @ts-expect-error 兼容内部实现：从管理器暴露 redis 实例
        await this.redisStreamManager["redis"].ping();
        const workers = this.workerRegistry.getWorkers();
        const healthyWorkers = this.workerRegistry.getHealthyWorkers();
        return c.json({
          status: "healthy",
          timestamp: new Date().toISOString(),
          database: "connected",
          redis: "connected",
          workers: {
            total: workers.length,
            healthy: healthyWorkers.length,
            unhealthy: workers.length - healthyWorkers.length,
          },
        });
      } catch (error) {
        logger.error("Health check failed:", error);
        return c.json(
          {
            status: "unhealthy",
            error: error instanceof Error ? error.message : "Unknown error",
          },
          503
        );
      }
    });

    // Worker 管理 API
    this.setupWorkerRoutes();

    // 指标 API
    this.setupMetricsRoutes();

    // 认证路由
    this.app.route("/auth", auth);

    // 兼容原有 API 路由
    this.app.route("/assistants", assistants);
    this.app.route("/threads", threads);
    this.app.route("/runs", runs);
    this.app.route("/store", store);
    this.app.route("/", meta);

    // 自定义运行 API - 调度 Worker 并转发 SSE
    this.setupCustomRunsAPI();
  }

  // Worker 管理路由（注册、列表、健康）
  private setupWorkerRoutes(): void {
    // 注册 Worker
    this.app.post("/workers/register", async (c) => {
      try {
        const body = await c.req.json();
        // 必要字段：workerId/workerType/url
        const workerId: string = body.workerId || crypto.randomUUID();
        const workerType: string = body.workerType || "js";
        const url: string = body.url;
        if (!url) {
          return c.json({ error: "Missing worker url" }, 400);
        }

        this.workerRegistry.registerWorker({ workerId, workerType, url });
        return c.json({ workerId, workerType, url }, 201);
      } catch (error) {
        logger.error("Failed to register worker:", error);
        return c.json({ error: "Internal error" }, 500);
      }
    });

    // Worker 列表
    this.app.get("/workers", (c) => {
      const workers = this.workerRegistry.getWorkers();
      return c.json(workers);
    });

    // Worker 健康
    this.app.get("/workers/:workerId/health", (c) => {
      const workerId = c.req.param("workerId");
      const worker = this.workerRegistry.getWorkers().find((w) => w.workerId === workerId);
      if (!worker) return c.json({ error: "Worker not found" }, 404);
      return c.json({ workerId, status: worker.status });
    });
  }

  // 指标路由
  private setupMetricsRoutes(): void {
    // 队列深度（pending runs 数量）
    this.app.get("/metrics/queue-depth", async (c) => {
      const pendingRuns = await this.postgresAdapter.runs.search({ status: ["pending"], limit: 1000 });
      return c.json({ queueDepth: pendingRuns.length, timestamp: new Date().toISOString() });
    });

    // Worker 状态聚合指标
    this.app.get("/metrics/workers", (c) => {
      const workers = this.workerRegistry.getWorkers();
      const metrics = workers.map((w) => ({
        workerId: w.workerId,
        workerType: w.workerType,
        status: w.status,
        activeTasks: w.metrics?.activeTasks ?? 0,
        totalTasks: w.metrics?.totalTasks ?? 0,
        avgResponseTime: w.metrics?.avgResponseTime ?? 0,
        errorRate: w.metrics?.errorRate ?? 0,
      }));
      return c.json(metrics);
    });
  }

  // 创建/取消/流式获取运行，调度到 Worker
  private setupCustomRunsAPI(): void {
    // 创建运行
    this.app.post("/threads/:threadId/runs", async (c) => {
      try {
        const threadId = c.req.param("threadId");
        const body = await c.req.json();
        const { assistant_id, input, config, metadata } = body;

        const assistant = await this.postgresAdapter.assistants.get(assistant_id);
        if (!assistant) return c.json({ error: "Assistant not found" }, 404);

        const worker = this.workerRegistry.selectWorker(assistant.graph_id);
        if (!worker) return c.json({ error: `No worker for graph ${assistant.graph_id}` }, 503);

        const runId = crypto.randomUUID();
        await this.postgresAdapter.runs.put(
          runId,
          assistant_id,
          { input, config },
          { threadId, status: "pending", metadata: { ...metadata, workerId: worker.workerId, workerType: worker.workerType } }
        );

        const workerClient = this.workerRegistry.getWorkerClient(worker.workerId);
        if (workerClient) {
          try {
            await workerClient.startRun({
              runId,
              threadId,
              graphId: assistant.graph_id,
              checkpointUri: this.config.databaseUrl,
              config: { ...assistant.config, ...config },
              inputs: input,
              metadata: metadata || {},
            });
            await this.postgresAdapter.runs.updateStatus(runId, "running");
            this.workerRegistry.updateWorkerMetrics(worker.workerId, {
              activeTasks: (worker.metrics?.activeTasks ?? 0) + 1,
              totalTasks: (worker.metrics?.totalTasks ?? 0) + 1,
            });
          } catch (err) {
            logger.error(`Start run failed on worker ${worker.workerId}:`, err);
            await this.postgresAdapter.runs.updateStatus(runId, "failed", { error: err instanceof Error ? err.message : "Worker error" });
          }
        }

        return c.json({ run_id: runId }, 201);
      } catch (error) {
        logger.error("Failed to create run:", error);
        return c.json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
      }
    });

    // 获取运行事件流（SSE 转发）
    this.app.get("/threads/:threadId/runs/:runId/stream", async (c) => {
      const runId = c.req.param("runId");
      try {
        const run = await this.postgresAdapter.runs.get(runId);
        if (!run) return c.json({ error: "Run not found" }, 404);
        const workerId = run.metadata?.workerId;
        if (!workerId) return c.json({ error: "No worker assigned" }, 400);
        const workerClient = this.workerRegistry.getWorkerClient(workerId);
        if (!workerClient) return c.json({ error: "Worker not available" }, 503);

        // SSE 响应头
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                for await (const event of workerClient.getRunStream(runId)) {
                  const sseData = `data: ${JSON.stringify(event)}\n\n`;
                  controller.enqueue(new TextEncoder().encode(sseData));
                  // 事件同时写入 Redis Streams 持久化（供回放与调试）
                  await (async () => {
                    try {
                      await this.redisStreamManager.publish(runId, event.event, event.data);
                    } catch (e) {
                      logger.warn(`Persist SSE event failed for ${runId}:`, e);
                    }
                  })();

                  if (event.event === "done" || event.event === "error") {
                    const status = event.event === "done" ? "completed" : "failed";
                    await this.postgresAdapter.runs.updateStatus(runId, status, event.data);
                    const worker = this.workerRegistry.getWorkers().find((w) => w.workerId === workerId);
                    if (worker) {
                      this.workerRegistry.updateWorkerMetrics(workerId, {
                        activeTasks: Math.max(0, (worker.metrics?.activeTasks ?? 1) - 1),
                      });
                    }
                    break;
                  }
                }
              } catch (err) {
                logger.error(`Stream error for run ${runId}:`, err);
                const errorData = `data: ${JSON.stringify({ event: "error", data: { message: "Stream error" } })}\n\n`;
                controller.enqueue(new TextEncoder().encode(errorData));
              } finally {
                controller.close();
              }
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          }
        );
      } catch (error) {
        logger.error(`Failed to get stream for run ${runId}:`, error);
        return c.json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
      }
    });

    // 取消运行
    this.app.post("/threads/:threadId/runs/:runId/cancel", async (c) => {
      const runId = c.req.param("runId");
      try {
        const body = await c.req.json();
        const action = body.action || "interrupt";
        const run = await this.postgresAdapter.runs.get(runId);
        if (!run) return c.json({ error: "Run not found" }, 404);
        const workerId = run.metadata?.workerId;
        if (workerId) {
          const workerClient = this.workerRegistry.getWorkerClient(workerId);
          if (workerClient) await workerClient.cancelRun(runId, action);
        }
        await this.redisCancellationManager.sendCancelSignal(runId, action);
        await this.postgresAdapter.runs.updateStatus(runId, "cancelled", { action });
        return c.json({ success: true });
      } catch (error) {
        logger.error(`Failed to cancel run ${runId}:`, error);
        return c.json({ error: error instanceof Error ? error.message : "Internal error" }, 500);
      }
    });
  }

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

