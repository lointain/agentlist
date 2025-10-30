// AgentList JavaScript Worker
// 实现 HTTP + SSE 协议的 LangGraph 执行器

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import winston from "winston";
import { Pool } from "pg";

// 导入 LangGraph 相关
// 注意：LangGraph 的 CompiledGraph 泛型签名复杂，为兼容不同版本，这里使用宽松类型
type GraphInstance = any; // 已编译图实例（包含 stream 等方法）
// 引入 Worker 侧图加载逻辑：支持路径+导出符语法与缓存
import { getGraph as getWorkerGraph, registerFromEnv as registerGraphsFromEnv } from "./graph/load.mts";

// 加载环境变量
dotenv.config();

// 配置日志
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
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
      )
    })
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
  action: z.enum(['interrupt', 'rollback']).optional().default('interrupt'),
});

type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
type CancelRunRequest = z.infer<typeof CancelRunRequestSchema>;

interface RunContext {
  runId: string;
  threadId: string;
  graphId: string;
  graph: GraphInstance; // 已编译图实例
  abortController: AbortController;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  // 事件缓冲与 SSE 连接集合（用于实时推送与历史回放）
  events: Array<{ event: string; data: any; timestamp: number }>; // 简单内存缓冲
  sseControllers: Set<ReadableStreamDefaultController>;
  // 步骤索引（用于写入数据库检查点）
  stepIndex: number;
}

interface WorkerConfig {
  port: number;
  host: string;
  workerId: string;
  orchestratorUrl?: string;
  maxConcurrency: number;
  heartbeatInterval: number;
  capabilities: {
    graphs: string[];
    version: string;
  };
}

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
      logger.warn('DATABASE_URL 未配置，Worker 将无法写入检查点。');
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
      logger.info(`${c.req.method} ${c.req.path} - ${c.res.status} (${duration}ms)`);
    });

    // CORS
    this.app.use("*", async (c, next) => {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (c.req.method === 'OPTIONS') {
        // 返回 204 无内容以满足 CORS 预检请求
        return new Response(null, { status: 204 });
      }
      
      await next();
    });
  }

  private setupRoutes(): void {
    // 健康检查
    this.app.get('/health', (c) => {
      const activeTasks = this.runningTasks.size;
      const uptime = process.uptime();
      
      return c.json({
        status: 'healthy',
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
    this.app.post('/runs', zValidator('json', StartRunRequestSchema), async (c) => {
      const request = c.req.valid('json');
      
      try {
        // 检查并发限制
        if (this.runningTasks.size >= this.config.maxConcurrency) {
          return c.json({
            error: 'Worker at maximum capacity',
            activeTasks: this.runningTasks.size,
            maxConcurrency: this.config.maxConcurrency,
          }, 503);
        }

        // 检查是否已在运行
        if (this.runningTasks.has(request.runId)) {
          return c.json({
            error: 'Run already in progress',
            runId: request.runId,
          }, 409);
        }

        // 获取图实例
        const graph = await this.getGraph(request.graphId);
        if (!graph) {
          return c.json({
            error: `Graph not found: ${request.graphId}`,
            availableGraphs: Array.from(this.graphs.keys()),
          }, 404);
        }

        // 创建运行上下文
        const runContext: RunContext = {
          runId: request.runId,
          threadId: request.threadId,
          graphId: request.graphId,
          graph,
          abortController: new AbortController(),
          status: 'running',
          startTime: Date.now(),
          events: [],
          sseControllers: new Set(),
          stepIndex: 0,
        };

        this.runningTasks.set(request.runId, runContext);

        // 异步执行图（不等待完成）
        this.executeGraph(runContext, request).catch(error => {
          logger.error(`Graph execution failed for run ${request.runId}:`, error);
          runContext.status = 'failed';
        });

        return c.json({
          runId: request.runId,
          status: 'accepted',
          streamUrl: `/runs/${request.runId}/stream`,
        }, 202);

      } catch (error) {
        logger.error('Failed to start run:', error);
        return c.json({
          error: error instanceof Error ? error.message : 'Internal error',
        }, 500);
      }
    });

    // 获取运行流
    this.app.get('/runs/:runId/stream', async (c) => {
      const runId = c.req.param('runId');
      const runContext = this.runningTasks.get(runId);

      if (!runContext) {
        return c.json({ error: 'Run not found' }, 404);
      }

      // 设置 SSE 响应头
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return new Response(
        new ReadableStream({
          start: (controller) => {
            // 监听运行状态变化并发送事件
            this.streamRunEvents(runContext, controller);
          },
          cancel: () => {
            logger.info(`Client disconnected from run ${runId} stream`);
          }
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          }
        }
      );
    });

    // 取消运行
    this.app.post('/runs/:runId/cancel', zValidator('json', CancelRunRequestSchema), async (c) => {
      const runId = c.req.param('runId');
      const { action } = c.req.valid('json');
      
      const runContext = this.runningTasks.get(runId);
      if (!runContext) {
        return c.json({ error: 'Run not found' }, 404);
      }

      try {
        // 发送取消信号
        runContext.abortController.abort(action);
        runContext.status = 'cancelled';
        
        logger.info(`Run ${runId} cancelled with action: ${action}`);
        return c.json({ success: true, action });
        
      } catch (error) {
        logger.error(`Failed to cancel run ${runId}:`, error);
        return c.json({
          error: error instanceof Error ? error.message : 'Cancel failed',
        }, 500);
      }
    });

    // 获取运行状态
    this.app.get('/runs/:runId', (c) => {
      const runId = c.req.param('runId');
      const runContext = this.runningTasks.get(runId);

      if (!runContext) {
        return c.json({ error: 'Run not found' }, 404);
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
    this.app.get('/runs', (c) => {
      const runs = Array.from(this.runningTasks.values()).map(ctx => ({
        runId: ctx.runId,
        threadId: ctx.threadId,
        graphId: ctx.graphId,
        status: ctx.status,
        duration: Date.now() - ctx.startTime,
      }));

      return c.json(runs);
    });
  }

  private async getGraph(graphId: string, config?: any): Promise<GraphInstance | null> {
    // 如果已缓存，直接返回
    if (this.graphs.has(graphId)) {
      return this.graphs.get(graphId)!;
    }

    try {
      // 使用统一的解析器加载图（支持路径+导出符语法）
      const graph = await getWorkerGraph(graphId, config, { cwd: process.cwd() });
      
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

  private async executeGraph(runContext: RunContext, request: StartRunRequest): Promise<void> {
    const { runId, graph, abortController } = runContext;
    
    try {
      logger.info(`Starting graph execution for run ${runId}`);
      
      // 检查点由我们在 worker 侧写入 Postgres，不再使用内存版 MemorySaver
      // 尝试恢复：当同一 runId 存在检查点时，回放最近 values 作为初始输入
      let startingInputs = request.inputs;
      try {
        const last = await this.readLastCheckpoint(request.runId);
        if (last && last.data && last.data.values !== undefined) {
          startingInputs = last.data.values;
          runContext.stepIndex = (last.step_index ?? 0) + 1;
          this.emitEvent(runContext, 'resume', { stepIndex: runContext.stepIndex });
          logger.info(`Resuming run ${runId} from step ${runContext.stepIndex}`);
        }
      } catch (err) {
        logger.warn(`读取最近检查点失败，按新运行执行 run=${runId}:`, err);
      }
      
      // 配置运行参数
      const config = {
        ...request.config,
        configurable: {
          thread_id: request.threadId,
          checkpoint_id: runId,
          ...request.config?.configurable,
        },
        signal: abortController.signal,
      };

      // 执行图并流式输出结果
      const stream = await graph.stream(startingInputs, config);
      
      for await (const chunk of stream) {
        // 检查是否被取消
        if (abortController.signal.aborted) {
          runContext.status = 'cancelled';
          break;
        }

        // 发送中间结果事件
        this.emitEvent(runContext, 'values', chunk);
        // 写入检查点到 Postgres（基于当前步索引）
        try {
          await this.writeCheckpoint(runContext, runContext.stepIndex, {
            values: chunk,
            metadata: request.metadata ?? {},
          });
          runContext.stepIndex += 1;
        } catch (err) {
          logger.error(`写入检查点失败 run=${runId} step=${runContext.stepIndex}:`, err);
        }
      }

      if (runContext.status === 'running') {
        runContext.status = 'completed';
        this.emitEvent(runContext, 'done', { runId });
      }

    } catch (error) {
      if (abortController.signal.aborted) {
        runContext.status = 'cancelled';
        this.emitEvent(runContext, 'error', { 
          message: 'Run was cancelled',
          action: abortController.signal.reason 
        });
      } else {
        runContext.status = 'failed';
        this.emitEvent(runContext, 'error', { 
          message: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    } finally {
      // 清理运行上下文
      setTimeout(() => {
        this.runningTasks.delete(runId);
        logger.info(`Cleaned up run context for ${runId}`);
      }, 30000); // 30秒后清理
    }
  }

  private emitEvent(runContext: RunContext, event: string, data: any): void {
    // 将事件写入内存缓冲，并推送给所有 SSE 订阅者
    const payload = { event, data, timestamp: Date.now() };
    runContext.events.push(payload);
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    const bytes = new TextEncoder().encode(line);
    for (const ctrl of runContext.sseControllers) {
      try {
        ctrl.enqueue(bytes);
      } catch (err) {
        // 某些连接可能已关闭，忽略错误
      }
    }
    // 将事件持久化到 events 表，便于历史回放与调试
    this.writeEvent(runContext.runId, event, data).catch((err) => {
      logger.warn(`写入事件失败 run=${runContext.runId} type=${event}:`, err);
    });
    logger.debug(`Event for run ${runContext.runId}: ${event}`);
  }

  private streamRunEvents(runContext: RunContext, controller: ReadableStreamDefaultController): void {
    // 将 controller 注册入集合，并回放历史事件
    runContext.sseControllers.add(controller);

    // 先发送启动事件
    const startPayload = { event: 'start', data: { runId: runContext.runId, status: runContext.status }, timestamp: Date.now() };
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startPayload)}\n\n`));
    // 持久化 start 事件
    this.writeEvent(runContext.runId, 'start', startPayload.data).catch(() => {});

    // 回放历史事件
    // 优先从数据库回放（支持 Worker 重启后的历史流），如果失败则退回内存缓冲
    (async () => {
      try {
        const persisted = await this.readEvents(runContext.runId);
        for (const evt of persisted) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(evt)}\n\n`));
        }
      } catch {
        for (const evt of runContext.events) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(evt)}\n\n`));
        }
      }
    })();

    // 注册关闭钩子：连接关闭时移除 controller
    const cleanup = () => {
      runContext.sseControllers.delete(controller);
    };
    // 简化：由调用方关闭时触发 finally
    // 状态完成/失败/取消时关闭所有连接
    const checkEnd = () => {
      if (runContext.status === 'completed') {
        const line = `data: ${JSON.stringify({ event: 'done', data: { runId: runContext.runId }, timestamp: Date.now() })}\n\n`;
        controller.enqueue(new TextEncoder().encode(line));
        controller.close();
        cleanup();
        return true;
      }
      if (runContext.status === 'failed' || runContext.status === 'cancelled') {
        const line = `data: ${JSON.stringify({ event: 'error', data: { runId: runContext.runId, status: runContext.status }, timestamp: Date.now() })}\n\n`;
        controller.enqueue(new TextEncoder().encode(line));
        controller.close();
        cleanup();
        return true;
      }
      return false;
    };

    // 周期检查，用于被动关闭（SSE 客户端不一定发关闭信号）
    const interval = setInterval(() => {
      if (checkEnd()) {
        clearInterval(interval);
      }
    }, 1000);
  }

  // 将检查点写入 Postgres：每个 values 事件作为一个 step
  private async writeCheckpoint(runContext: RunContext, stepIndex: number, data: any): Promise<void> {
    if (!this.pool) return;
    const checkpointId = uuidv4();
    await this.pool.query(
      `INSERT INTO checkpoints (checkpoint_id, thread_id, run_id, step_index, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [checkpointId, runContext.threadId, runContext.runId, stepIndex, JSON.stringify(data)]
    );
  }

  // 从 Postgres 读取最近检查点（用于断点续跑）
  private async readLastCheckpoint(runId: string): Promise<{ step_index: number; data: any } | null> {
    if (!this.pool) return null;
    const res = await this.pool.query(
      `SELECT step_index, data FROM checkpoints WHERE run_id = $1 ORDER BY step_index DESC LIMIT 1`,
      [runId]
    );
    if (res && typeof res.rowCount === 'number' && res.rowCount > 0) {
      const row = res.rows[0];
      return { step_index: Number(row.step_index), data: row.data };
    }
    return null;
  }

  // 将事件写入 Postgres 的 events 表（SSE 持久化）
  private async writeEvent(runId: string, type: string, data: any): Promise<void> {
    if (!this.pool) return;
    const eventId = uuidv4();
    await this.pool.query(
      `INSERT INTO events (event_id, run_id, type, data, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [eventId, runId, type, JSON.stringify(data)]
    );
  }

  // 读取某个 run 的历史事件（按时间顺序）
  private async readEvents(runId: string): Promise<Array<{ event: string; data: any; timestamp: number }>> {
    if (!this.pool) return [];
    const res = await this.pool.query(
      `SELECT type AS event, data, extract(epoch from created_at)*1000 AS timestamp FROM events WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    return res.rows.map((r) => ({ event: r.event, data: r.data, timestamp: Number(r.timestamp) }));
  }

  private async registerWithOrchestrator(): Promise<void> {
    if (!this.config.orchestratorUrl) {
      logger.info('No orchestrator URL configured, skipping registration');
      return;
    }

    try {
      const response = await fetch(`${this.config.orchestratorUrl}/workers/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workerId: this.config.workerId,
          workerType: 'js',
          endpointUrl: `http://${this.config.host}:${this.config.port}`,
          status: 'active',
          capabilities: this.config.capabilities,
          lastHeartbeat: new Date(),
        }),
      });

      if (response.ok) {
        logger.info(`Successfully registered with orchestrator: ${this.config.orchestratorUrl}`);
      } else {
        logger.error(`Failed to register with orchestrator: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Error registering with orchestrator:', error);
    }
  }

  private startHeartbeat(): void {
    if (!this.config.orchestratorUrl) {
      return;
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        const response = await fetch(
          `${this.config.orchestratorUrl}/workers/${this.config.workerId}/heartbeat`,
          { method: 'POST' }
        );

        if (!response.ok) {
          logger.warn(`Heartbeat failed: ${response.statusText}`);
        }
      } catch (error) {
        logger.error('Heartbeat error:', error);
      }
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async start(): Promise<void> {
    // 注册到协调器
    await this.registerWithOrchestrator();
    
    // 在 Worker 启动时支持从环境变量预注册图
    // 约定：WORKER_GRAPHS 为 JSON，形如 { "graphA": "./graphs/graphA.mjs", "graphB": "./graphs/graphB.mjs:build" }
    try {
      const raw = process.env.WORKER_GRAPHS;
      if (raw) {
        const specs = JSON.parse(raw) as Record<string, string>;
        await registerGraphsFromEnv(specs, { cwd: process.cwd() });
        logger.info(`Registered graphs from env: ${Object.keys(specs).join(', ')}`);
      }
    } catch (err) {
      logger.warn('Failed to register graphs from WORKER_GRAPHS:', err);
    }

    // 启动心跳
    this.startHeartbeat();
    
    // 启动服务器
    const server = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    logger.info(`AgentList JS Worker started on ${this.config.host}:${this.config.port}`);
    logger.info(`Worker ID: ${this.config.workerId}`);
    logger.info(`Max Concurrency: ${this.config.maxConcurrency}`);
    logger.info(`Capabilities: ${this.config.capabilities.graphs.join(', ')}`);
    
    // 注意：start() 不返回 server，保持签名为 Promise<void>
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    
    // 取消所有运行中的任务
    for (const runContext of this.runningTasks.values()) {
      runContext.abortController.abort('shutdown');
    }
    // 关闭数据库连接
    try {
      await this.pool.end();
    } catch (err) {
      logger.warn('关闭数据库连接失败:', err);
    }
    
    logger.info('AgentList JS Worker stopped');
  }
}

// 启动 Worker 的便捷函数
export async function startWorker(config?: Partial<WorkerConfig>): Promise<AgentListWorker> {
  const defaultConfig: WorkerConfig = {
    port: parseInt(process.env.WORKER_PORT || '3001'),
    host: process.env.WORKER_HOST || '0.0.0.0',
    workerId: process.env.WORKER_ID || `js-worker-${uuidv4()}`,
    orchestratorUrl: process.env.ORCHESTRATOR_URL,
    maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '10'),
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000'),
    capabilities: {
      graphs: (process.env.SUPPORTED_GRAPHS || '*').split(','),
      version: process.env.npm_package_version || '1.0.0',
    },
  };

  const finalConfig = { ...defaultConfig, ...config };
  const worker = new AgentListWorker(finalConfig);
  
  await worker.start();
  return worker;
}

// 如果直接运行此文件，启动 Worker
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker().catch(error => {
    logger.error('Failed to start worker:', error);
    process.exit(1);
  });
}