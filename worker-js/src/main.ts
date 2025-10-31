// AgentList JavaScript Worker
// 实现 HTTP + SSE 协议的 LangGraph 执行器

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";
import { Pool } from "pg";
// 运行时模块：类型与事件/检查点逻辑
import { GraphInstance, RunContext, WorkerConfig } from "./runtime/types.js";
import {
  writeCheckpoint as rtWriteCheckpoint,
  readLastCheckpoint as rtReadLastCheckpoint,
} from "./runtime/checkpoints.js";
import {
  emitEvent as rtEmitEvent,
  streamRunEvents as rtStreamRunEvents,
  writeEvent as rtWriteEvent,
  readEvents as rtReadEvents,
} from "./runtime/events.js";
import { executeGraph as rtExecuteGraph } from "./runtime/execution.js";
import {
  registerWithOrchestrator as rtRegisterWithServer,
  startHeartbeat as rtStartHeartbeat,
  stopHeartbeat as rtStopHeartbeat,
} from "./runtime/lifecycle.js";

// 导入 LangGraph 相关
// 引入 Worker 侧图加载逻辑：支持路径+导出符语法与缓存
import {
  getGraph as getWorkerGraph,
  registerFromEnv as registerGraphsFromEnv,
} from "./graph/load.js";
import {
  parseLanggraphJson,
  tryParseDefaultLanggraphJson,
} from "./graph/langgraph.config.js";

// 加载环境变量
dotenv.config({ path: ".//.env" });

// 配置日志
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// 请求和响应类型定义
const StartRunRequestSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  graphId: z.string(),
  checkpointUri: z.string(),
  config: z.any(),
  inputs: z.any(),
  metadata: z.record(z.any()).optional(),
});

const CancelRunRequestSchema = z.object({
  action: z.enum(["interrupt", "rollback"]).optional().default("interrupt"),
});

type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

// RunContext/WorkerConfig 已迁移至 runtime/types.mts

export class AgentListWorker {
  private app: Hono;
  private config: WorkerConfig;
  private runningTasks = new Map<string, RunContext>();
  private graphs = new Map<string, GraphInstance>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  // Postgres 连接池：用于写入检查点
  private pool: Pool;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.app = new Hono();
    // 初始化 Postgres 连接池（基于环境变量 DATABASE_URL）
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.warn("DATABASE_URL 未配置，Worker 将无法写入检查点。");
    }
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use("*", contextStorage());

    // 请求日志
    this.app.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      const duration = Date.now() - start;
      logger.info(
        `${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`
      );
    });

    // CORS
    this.app.use("*", async (c, next) => {
      c.header("Access-Control-Allow-Origin", "*");
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (c.req.method === "OPTIONS") {
        // 返回 204 无内容以满足 CORS 预检请求
        return new Response(null, { status: 204 });
      }

      await next();
    });
  }

  private setupRoutes(): void {
    // 健康检查
    this.app.get("/health", (c) => {
      const activeTasks = this.runningTasks.size;
      const uptime = process.uptime();

      return c.json({
        status: "healthy",
        workerId: this.config.workerId,
        activeTasks,
        maxConcurrency: this.config.maxConcurrency,
        uptime,
        version: this.config.capabilities.version,
        capabilities: this.config.capabilities.graphs,
        timestamp: new Date().toISOString(),
      });
    });

    // 启动运行
    this.app.post(
      "/runs",
      zValidator("json", StartRunRequestSchema),
      async (c) => {
        const request = c.req.valid("json");

        try {
          // 检查并发限制
          if (this.runningTasks.size >= this.config.maxConcurrency) {
            return c.json(
              {
                error: "Worker at maximum capacity",
                activeTasks: this.runningTasks.size,
                maxConcurrency: this.config.maxConcurrency,
              },
              503
            );
          }

          // 检查是否已在运行
          if (this.runningTasks.has(request.runId)) {
            return c.json(
              {
                error: "Run already in progress",
                runId: request.runId,
              },
              409
            );
          }

          // 获取图实例
          const graph = await this.getGraph(request.graphId);
          if (!graph) {
            return c.json(
              {
                error: `Graph not found: ${request.graphId}`,
                availableGraphs: Array.from(this.graphs.keys()),
              },
              404
            );
          }

          // 创建运行上下文
          const runContext: RunContext = {
            runId: request.runId,
            threadId: request.threadId,
            graphId: request.graphId,
            graph,
            abortController: new AbortController(),
            status: "running",
            startTime: Date.now(),
            events: [],
            sseControllers: new Set(),
            stepIndex: 0,
          };

          this.runningTasks.set(request.runId, runContext);

          // 异步执行图（不等待完成）
          this.executeGraph(runContext, request).catch((error) => {
            logger.error(
              `Graph execution failed for run ${request.runId}:`,
              error
            );
            runContext.status = "failed";
          });

          return c.json(
            {
              runId: request.runId,
              status: "accepted",
              streamUrl: `/runs/${request.runId}/stream`,
            },
            202
          );
        } catch (error) {
          logger.error("Failed to start run:", error);
          return c.json(
            {
              error: error instanceof Error ? error.message : "Internal error",
            },
            500
          );
        }
      }
    );

    // 获取运行流
    this.app.get("/runs/:runId/stream", async (c) => {
      const runId = c.req.param("runId");
      const runContext = this.runningTasks.get(runId);

      if (!runContext) {
        return c.json({ error: "Run not found" }, 404);
      }

      // 设置 SSE 响应头
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return new Response(
        new ReadableStream({
          start: (controller) => {
            // 监听运行状态变化并发送事件
            this.streamRunEvents(runContext, controller);
          },
          cancel: () => {
            logger.info(`Client disconnected from run ${runId} stream`);
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }
      );
    });

    // 取消运行
    this.app.post(
      "/runs/:runId/cancel",
      zValidator("json", CancelRunRequestSchema),
      async (c) => {
        const runId = c.req.param("runId");
        const { action } = c.req.valid("json");

        const runContext = this.runningTasks.get(runId);
        if (!runContext) {
          return c.json({ error: "Run not found" }, 404);
        }

        try {
          // 发送取消信号
          runContext.abortController.abort(action);
          runContext.status = "cancelled";

          logger.info(`Run ${runId} cancelled with action: ${action}`);
          return c.json({ success: true, action });
        } catch (error) {
          logger.error(`Failed to cancel run ${runId}:`, error);
          return c.json(
            {
              error: error instanceof Error ? error.message : "Cancel failed",
            },
            500
          );
        }
      }
    );

    // 获取运行状态
    this.app.get("/runs/:runId", (c) => {
      const runId = c.req.param("runId");
      const runContext = this.runningTasks.get(runId);

      if (!runContext) {
        return c.json({ error: "Run not found" }, 404);
      }

      return c.json({
        runId: runContext.runId,
        threadId: runContext.threadId,
        graphId: runContext.graphId,
        status: runContext.status,
        duration: Date.now() - runContext.startTime,
      });
    });

    // 获取所有运行
    this.app.get("/runs", (c) => {
      const runs = Array.from(this.runningTasks.values()).map((ctx) => ({
        runId: ctx.runId,
        threadId: ctx.threadId,
        graphId: ctx.graphId,
        status: ctx.status,
        duration: Date.now() - ctx.startTime,
      }));

      return c.json(runs);
    });
  }

  private async getGraph(
    graphId: string,
    config?: any
  ): Promise<GraphInstance | null> {
    // 如果已缓存，直接返回
    if (this.graphs.has(graphId)) {
      return this.graphs.get(graphId)!;
    }

    try {
      // 使用统一的解析器加载图（支持路径+导出符语法）
      const graph = await getWorkerGraph(graphId, config, {
        cwd: process.cwd(),
      });

      if (graph) {
        this.graphs.set(graphId, graph as GraphInstance);
      }

      return graph;
    } catch (error) {
      logger.error(`Failed to load graph ${graphId}:`, error);
      return null;
    }
  }

  // 旧的 loadGraphFromSource 已由统一的解析器替代

  private async executeGraph(
    runContext: RunContext,
    request: StartRunRequest
  ): Promise<void> {
    await rtExecuteGraph({ pool: this.pool, logger }, runContext, request);
    // 清理运行上下文（保持与原实现一致的延迟释放）
    setTimeout(() => {
      this.runningTasks.delete(runContext.runId);
      logger.info(`Cleaned up run context for ${runContext.runId}`);
    }, 30000);
  }

  private emitEvent(runContext: RunContext, event: string, data: any): void {
    rtEmitEvent(
      { pool: this.pool, logger },
      runContext,
      event,
      data
    );
  }

  private streamRunEvents(
    runContext: RunContext,
    controller: ReadableStreamDefaultController
  ): void {
    rtStreamRunEvents(
      { pool: this.pool, logger },
      runContext,
      controller
    ).catch((err) => {
      const line = `event: error\ndata: ${JSON.stringify({
        message: String(err),
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    });
  }

  // 将检查点写入 Postgres：每个 values 事件作为一个 step
  private async writeCheckpoint(
    runContext: RunContext,
    stepIndex: number,
    data: any
  ): Promise<void> {
    return rtWriteCheckpoint(
      { pool: this.pool, logger },
      runContext,
      stepIndex,
      data
    );
  }

  // 从 Postgres 读取最近检查点（用于断点续跑）
  private async readLastCheckpoint(
    runId: string
  ): Promise<{ step_index: number; data: any } | null> {
    return rtReadLastCheckpoint(
      { pool: this.pool, logger },
      runId
    );
  }

  // 将事件写入 Postgres 的 events 表（SSE 持久化）
  private async writeEvent(
    runId: string,
    type: string,
    data: any
  ): Promise<void> {
    return rtWriteEvent(
      { pool: this.pool, logger },
      runId,
      type,
      data
    );
  }

  // 读取某个 run 的历史事件（按时间顺序）
  private async readEvents(
    runId: string
  ): Promise<Array<{ event: string; data: any; timestamp: number }>> {
    return rtReadEvents({ pool: this.pool, logger }, runId);
  }

  // 注册/心跳逻辑已抽离到 runtime/lifecycle.mts

  async start(): Promise<void> {
    // 注册到协调器
    await rtRegisterWithServer(this.config, { pool: this.pool, logger });

    // 优先尝试基于标准 langgraph.json 注册图（符合 langgraphjs 项目结构）
    try {
      const configPath =
        process.env.LANGGRAPH_CONFIG_PATH ||
        path.join(process.cwd(), "langgraph.json");
      let cfg: { specs: Record<string, string>; baseDir: string } | null = null;
      if (fs.existsSync(configPath)) {
        cfg = parseLanggraphJson(configPath);
      } else {
        cfg = tryParseDefaultLanggraphJson();
      }
      if (cfg && Object.keys(cfg.specs).length > 0) {
        await registerGraphsFromEnv(cfg.specs, { cwd: cfg.baseDir });
        logger.info(
          `Registered graphs from langgraph.json: ${Object.keys(cfg.specs).join(
            ", "
          )}`
        );
      } else {
        logger.info(
          "No langgraph.json found or no JS graphs defined; skipping"
        );
      }
    } catch (err) {
      logger.warn("Failed to register graphs from langgraph.json:", err);
    }

    // 在 Worker 启动时支持从环境变量预注册图
    // 约定：WORKER_GRAPHS 为 JSON，形如 { "graphA": "./graphs/graphA.mjs", "graphB": "./graphs/graphB.mjs:build" }
    try {
      const raw = process.env.WORKER_GRAPHS;
      if (raw) {
        const specs = JSON.parse(raw) as Record<string, string>;
        await registerGraphsFromEnv(specs, { cwd: process.cwd() });
        logger.info(
          `Registered graphs from env: ${Object.keys(specs).join(", ")}`
        );
      }
    } catch (err) {
      logger.warn("Failed to register graphs from WORKER_GRAPHS:", err);
    }

    // 启动心跳
    this.heartbeatTimer = rtStartHeartbeat(this.config, {
      pool: this.pool,
      logger,
    });

    // 启动服务器
    const server = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    console.log(
      `AgentList JS Worker started on ${this.config.host}:${this.config.port}`
    );
    console.log(`Worker ID: ${this.config.workerId}`);
    console.log(`Max Concurrency: ${this.config.maxConcurrency}`);
    console.log(`Capabilities: ${this.config.capabilities.graphs.join(", ")}`);

    // 注意：start() 不返回 server，保持签名为 Promise<void>
  }

  async stop(): Promise<void> {
    rtStopHeartbeat(this.heartbeatTimer);
    this.heartbeatTimer = null;

    // 取消所有运行中的任务
    for (const runContext of this.runningTasks.values()) {
      runContext.abortController.abort("shutdown");
    }
    // 关闭数据库连接
    try {
      await this.pool.end();
    } catch (err) {
      logger.warn("关闭数据库连接失败:", err);
    }

    logger.info("AgentList JS Worker stopped");
  }
}

// 启动 Worker 的便捷函数
export async function startWorker(
  config?: Partial<WorkerConfig>
): Promise<AgentListWorker> {
  // console.log("环境变量检查:");
  // console.log(`process.env: ${JSON.stringify(process.env)}`);

  const defaultConfig: WorkerConfig = {
    port: parseInt(process.env.PORT || "3001"),
    host: process.env.HOST || "0.0.0.0",
    workerId: process.env.WORKER_ID || `js-worker-${uuidv4()}`,

    serverUrl: process.env.SERVER_URL,
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || "10"),
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "30000"),
    capabilities: {
      graphs: (process.env.SUPPORTED_GRAPHS || "*").split(","),
      version: process.env.npm_package_version || "1.0.0",
    },
  };

  const finalConfig = { ...defaultConfig, ...config };
  const worker = new AgentListWorker(finalConfig);

  await worker.start();
  console.log("Worker start method called.");
  return worker;
}

// 如果直接运行此文件，启动 Worker
startWorker().catch((error) => {
  logger.error("Failed to start worker:", error);
  process.exit(1);
});
