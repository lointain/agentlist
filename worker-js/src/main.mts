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

// 导入 LangGraph 相关
import { CompiledGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

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
  graph: CompiledGraph;
  abortController: AbortController;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
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
  private graphs = new Map<string, CompiledGraph>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.app = new Hono();
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
        return c.text('', 204);
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

  private async getGraph(graphId: string): Promise<CompiledGraph | null> {
    // 如果已缓存，直接返回
    if (this.graphs.has(graphId)) {
      return this.graphs.get(graphId)!;
    }

    try {
      // 动态加载图（这里需要根据实际情况实现）
      // 可以从文件系统、数据库或其他来源加载图定义
      const graph = await this.loadGraphFromSource(graphId);
      
      if (graph) {
        this.graphs.set(graphId, graph);
      }
      
      return graph;
    } catch (error) {
      logger.error(`Failed to load graph ${graphId}:`, error);
      return null;
    }
  }

  private async loadGraphFromSource(graphId: string): Promise<CompiledGraph | null> {
    // 这里是示例实现，实际应该根据 graphId 加载对应的图
    // 可以从配置文件、数据库或动态编译源码
    
    try {
      // 示例：尝试从 graphs 目录加载
      const graphPath = `./graphs/${graphId}.mjs`;
      const graphModule = await import(graphPath);
      
      if (graphModule.default && typeof graphModule.default.compile === 'function') {
        return graphModule.default.compile();
      }
      
      return null;
    } catch (error) {
      logger.warn(`Could not load graph from ${graphId}:`, error);
      return null;
    }
  }

  private async executeGraph(runContext: RunContext, request: StartRunRequest): Promise<void> {
    const { runId, graph, abortController } = runContext;
    
    try {
      logger.info(`Starting graph execution for run ${runId}`);
      
      // 配置检查点保存器（这里使用内存，实际可以连接到共享存储）
      const checkpointer = new MemorySaver();
      
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
      const stream = await graph.stream(request.inputs, config);
      
      for await (const chunk of stream) {
        // 检查是否被取消
        if (abortController.signal.aborted) {
          runContext.status = 'cancelled';
          break;
        }

        // 发送中间结果事件
        this.emitEvent(runContext, 'values', chunk);
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
    // 这里可以实现事件发送逻辑
    // 在实际实现中，可能需要将事件存储到队列中，供 SSE 流消费
    logger.debug(`Event for run ${runContext.runId}: ${event}`, data);
  }

  private streamRunEvents(runContext: RunContext, controller: ReadableStreamDefaultController): void {
    // 实现 SSE 事件流
    // 这里是简化版本，实际需要更复杂的事件管理
    
    const sendEvent = (event: string, data: any) => {
      const sseData = `data: ${JSON.stringify({ event, data, timestamp: Date.now() })}\n\n`;
      controller.enqueue(new TextEncoder().encode(sseData));
    };

    // 发送初始状态
    sendEvent('start', { runId: runContext.runId, status: runContext.status });

    // 监听状态变化（这里需要实现更完善的事件系统）
    const checkStatus = () => {
      if (runContext.status === 'completed') {
        sendEvent('done', { runId: runContext.runId });
        controller.close();
      } else if (runContext.status === 'failed' || runContext.status === 'cancelled') {
        sendEvent('error', { runId: runContext.runId, status: runContext.status });
        controller.close();
      } else {
        // 继续检查
        setTimeout(checkStatus, 1000);
      }
    };

    checkStatus();
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
    
    return server;
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    
    // 取消所有运行中的任务
    for (const runContext of this.runningTasks.values()) {
      runContext.abortController.abort('shutdown');
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