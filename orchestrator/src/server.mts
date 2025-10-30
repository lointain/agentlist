// AgentList Orchestrator 服务�?// 集成 PostgreSQL、Redis Streams �?Worker 管理的高并发版本

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { z } from "zod";
import dotenv from "dotenv";

// 导入存储适配�?import { PostgresAdapter } from "./storage/postgres.mts";
import { RedisStreamManager, RedisLockManager, RedisCancellationManager } from "./storage/redis-streams.mts";

// 导入 Worker 管理
import { WorkerRegistry } from "./worker/registry.mts";

// 导入中间�?import { createMultiLevelRateLimit } from "./middleware/rate-limit.mts";

// 导入原有 API 路由（需要适配�?import runs from "./api/runs.mts";
import threads from "./api/threads.mts";
import assistants from "./api/assistants.mts";
import store from "./api/store.mts";
import meta from "./api/meta.mts";

// 导入工具
import { logger, requestLogger } from "./logging.mts";
import { cors, ensureContentType } from "./http/middleware.mts";

// 加载环境变量
dotenv.config();

export interface ServerConfig {
  port: number;
  host: string;
  
  // 数据库配�?  databaseUrl: string;
  redisUrl: string;
  
  // Worker 配置
  workers: {
    js?: string;
    python?: string;
  };
  
  // 功能开�?  enableRateLimit: boolean;
  enableAuth: boolean;
  
  // 性能配置
  maxConnections: number;
  healthCheckInterval: number;
}

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
    
    // 初始化存储适配�?    this.postgresAdapter = new PostgresAdapter({
      connectionString: config.databaseUrl,
      maxConnections: config.maxConnections,
    });

    // 初始�?Redis 组件
    const redisConfig = { url: config.redisUrl };
    this.redisStreamManager = new RedisStreamManager(redisConfig);
    this.redisLockManager = new RedisLockManager(redisConfig);
    this.redisCancellationManager = new RedisCancellationManager(redisConfig);

    // 初始�?Worker 注册�?    this.workerRegistry = new WorkerRegistry(config.healthCheckInterval);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // 基础中间�?    this.app.use("*", contextStorage());
    this.app.use("*", requestLogger());
    this.app.use("*", cors());
    this.app.use("*", ensureContentType());

    // 限流中间�?    if (this.config.enableRateLimit) {
      const rateLimitMiddleware = createMultiLevelRateLimit(
        // 传入 Redis 实例用于跨实例共�?        this.redisStreamManager['redis'] // 复用 Redis 连接
      );
      
      rateLimitMiddleware.forEach(middleware => {
        this.app.use("*", middleware);
      });
    }

    // 注入依赖到上下文
    this.app.use("*", async (c, next) => {
      // 注入存储适配�?      c.set('postgres', this.postgresAdapter);
      c.set('redisStreams', this.redisStreamManager);
      c.set('redisLocks', this.redisLockManager);
      c.set('redisCancellation', this.redisCancellationManager);
      c.set('workerRegistry', this.workerRegistry);
      
      await next();
    });
  }

  private setupRoutes(): void {
    // 健康检�?    this.app.get('/health', async (c) => {
      try {
        // 检查数据库连接
        await this.postgresAdapter.runs.search({ limit: 1 });
        
        // 检�?Redis 连接
        await this.redisStreamManager['redis'].ping();
        
        // 获取 Worker 状�?        const workers = this.workerRegistry.getWorkers();
        const healthyWorkers = this.workerRegistry.getHealthyWorkers();
        
        return c.json({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected',
          redis: 'connected',
          workers: {
            total: workers.length,
            healthy: healthyWorkers.length,
            unhealthy: workers.length - healthyWorkers.length,
          },
        });
      } catch (error) {
        logger.error('Health check failed:', error);
        return c.json({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error',
        }, 503);
      }
    });

    // Worker 管理 API
    this.setupWorkerRoutes();

    // 指标 API
    this.setupMetricsRoutes();

    // 原有 API 路由（需要适配新的存储层）
    this.app.route('/assistants', assistants);
    this.app.route('/threads', threads);
    this.app.route('/runs', runs);
    this.app.route('/store', store);
    this.app.route('/', meta);

    // 自定义运�?API - 集成 Worker 调度
    this.setupCustomRunsAPI();
  }

  private setupWorkerRoutes(): void {
    // 获取 Worker 列表
    this.app.get('/workers', async (c) => {
      const workers = this.workerRegistry.getWorkers();
      return c.json(workers);
    });

    // 注册 Worker
    this.app.post('/workers/register', async (c) => {
      const body = await c.req.json();
      await this.workerRegistry.registerWorker(body);
      return c.json({ success: true });
    });

    // 注销 Worker
    this.app.delete('/workers/:workerId', async (c) => {
      const workerId = c.req.param('workerId');
      await this.workerRegistry.unregisterWorker(workerId);
      return c.json({ success: true });
    });

    // Worker 心跳
    this.app.post('/workers/:workerId/heartbeat', async (c) => {
      const workerId = c.req.param('workerId');
      this.workerRegistry.updateHeartbeat(workerId);
      return c.json({ success: true });
    });
  }

  private setupMetricsRoutes(): void {
    // 队列深度
    this.app.get('/metrics/queue-depth', async (c) => {
      const pendingRuns = await this.postgresAdapter.runs.search({
        status: ['pending'],
        limit: 1000,
      });
      
      return c.json({
        queueDepth: pendingRuns.length,
        timestamp: new Date().toISOString(),
      });
    });

    // Worker 状�?    this.app.get('/metrics/workers', async (c) => {
      const workers = this.workerRegistry.getWorkers();
      const metrics = workers.map(w => ({
        workerId: w.workerId,
        workerType: w.workerType,
        status: w.status,
        activeTasks: w.metrics.activeTasks,
        totalTasks: w.metrics.totalTasks,
        avgResponseTime: w.metrics.avgResponseTime,
        errorRate: w.metrics.errorRate,
      }));
      
      return c.json(metrics);
    });
  }

  private setupCustomRunsAPI(): void {
    // 创建运行 - 集成 Worker 调度
    this.app.post('/threads/:threadId/runs', async (c) => {
      try {
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        
        const { assistant_id, input, config, metadata } = body;
        
        // 获取助手信息
        const assistant = await this.postgresAdapter.assistants.get(assistant_id);
        if (!assistant) {
          return c.json({ error: 'Assistant not found' }, 404);
        }

        // 选择合适的 Worker
        const worker = this.workerRegistry.selectWorker(assistant.graph_id);
        if (!worker) {
          return c.json({ 
            error: `No available worker for graph: ${assistant.graph_id}` 
          }, 503);
        }

        // 生成运行 ID
        const runId = crypto.randomUUID();
        
        // 创建运行记录
        await this.postgresAdapter.runs.put(
          runId,
          assistant_id,
          { input, config },
          { 
            threadId, 
            status: 'pending',
            metadata: { 
              ...metadata, 
              workerId: worker.workerId,
              workerType: worker.workerType 
            }
          }
        );

        // 调度�?Worker
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

            // 更新运行状�?            await this.postgresAdapter.runs.updateStatus(runId, 'running');
            
            // 更新 Worker 指标
            this.workerRegistry.updateWorkerMetrics(worker.workerId, {
              activeTasks: worker.metrics.activeTasks + 1,
              totalTasks: worker.metrics.totalTasks + 1,
            });

          } catch (error) {
            logger.error(`Failed to start run on worker ${worker.workerId}:`, error);
            await this.postgresAdapter.runs.updateStatus(runId, 'failed', {
              error: error instanceof Error ? error.message : 'Worker error'
            });
          }
        }

        return c.json({ run_id: runId }, 201);
        
      } catch (error) {
        logger.error('Failed to create run:', error);
        return c.json({ 
          error: error instanceof Error ? error.message : 'Internal error' 
        }, 500);
      }
    });

    // 获取运行�?- �?Worker 转发 SSE
    this.app.get('/threads/:threadId/runs/:runId/stream', async (c) => {
      const runId = c.req.param('runId');
      
      try {
        // 获取运行信息
        const run = await this.postgresAdapter.runs.get(runId);
        if (!run) {
          return c.json({ error: 'Run not found' }, 404);
        }

        const workerId = run.metadata?.workerId;
        if (!workerId) {
          return c.json({ error: 'No worker assigned to this run' }, 400);
        }

        const workerClient = this.workerRegistry.getWorkerClient(workerId);
        if (!workerClient) {
          return c.json({ error: 'Worker not available' }, 503);
        }

        // 设置 SSE 响应�?        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('Connection', 'keep-alive');

        // 创建流响�?        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                // �?Worker 获取事件流并转发
                for await (const event of workerClient.getRunStream(runId)) {
                  const sseData = `data: ${JSON.stringify(event)}\n\n`;
                  controller.enqueue(new TextEncoder().encode(sseData));
                  
                  // 同时写入 Redis Streams 用于持久�?                  await this.redisStreamManager.publish(runId, event.event, event.data);
                  
                  // 如果是结束事件，更新运行状�?                  if (event.event === 'done' || event.event === 'error') {
                    const status = event.event === 'done' ? 'completed' : 'failed';
                    await this.postgresAdapter.runs.updateStatus(runId, status, event.data);
                    
                    // 更新 Worker 指标
                    const worker = this.workerRegistry.getWorkers()
                      .find(w => w.workerId === workerId);
                    if (worker) {
                      this.workerRegistry.updateWorkerMetrics(workerId, {
                        activeTasks: Math.max(0, worker.metrics.activeTasks - 1),
                      });
                    }
                    break;
                  }
                }
              } catch (error) {
                logger.error(`Stream error for run ${runId}:`, error);
                const errorData = `data: ${JSON.stringify({
                  event: 'error',
                  data: { message: 'Stream error' }
                })}\n\n`;
                controller.enqueue(new TextEncoder().encode(errorData));
              } finally {
                controller.close();
              }
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

      } catch (error) {
        logger.error(`Failed to get stream for run ${runId}:`, error);
        return c.json({ 
          error: error instanceof Error ? error.message : 'Internal error' 
        }, 500);
      }
    });

    // 取消运行
    this.app.post('/threads/:threadId/runs/:runId/cancel', async (c) => {
      const runId = c.req.param('runId');
      const body = await c.req.json();
      const action = body.action || 'interrupt';
      
      try {
        const run = await this.postgresAdapter.runs.get(runId);
        if (!run) {
          return c.json({ error: 'Run not found' }, 404);
        }

        const workerId = run.metadata?.workerId;
        if (workerId) {
          const workerClient = this.workerRegistry.getWorkerClient(workerId);
          if (workerClient) {
            await workerClient.cancelRun(runId, action);
          }
        }

        // 发送取消信�?        await this.redisCancellationManager.sendCancelSignal(runId, action);
        
        // 更新运行状�?        await this.postgresAdapter.runs.updateStatus(runId, 'cancelled', { action });

        return c.json({ success: true });
        
      } catch (error) {
        logger.error(`Failed to cancel run ${runId}:`, error);
        return c.json({ 
          error: error instanceof Error ? error.message : 'Internal error' 
        }, 500);
      }
    });
  }

  async start(): Promise<void> {
    // 注册预配置的 Worker
    await this.registerConfiguredWorkers();
    
    // 启动 Worker 健康检�?    this.workerRegistry.startHealthCheck();
    
    // 启动服务�?    const server = serve({
      fetch: this.app.fetch,
      port: this.config.port,
      hostname: this.config.host,
    });

    logger.info(`AgentList Orchestrator started on ${this.config.host}:${this.config.port}`);
    logger.info(`Database: ${this.config.databaseUrl.replace(/\/\/.*@/, '//***@')}`);
    logger.info(`Redis: ${this.config.redisUrl.replace(/\/\/.*@/, '//***@')}`);
    
    return server;
  }

  async stop(): Promise<void> {
    // 停止健康检�?    this.workerRegistry.stopHealthCheck();
    
    // 关闭连接
    await this.postgresAdapter.close();
    await this.redisStreamManager.close();
    await this.redisLockManager.close();
    await this.redisCancellationManager.close();
    
    logger.info('AgentList Orchestrator stopped');
  }

  private async registerConfiguredWorkers(): Promise<void> {
    const { workers } = this.config;
    
    if (workers.js) {
      await this.workerRegistry.registerWorker({
        workerId: 'worker-js-1',
        workerType: 'js',
        endpointUrl: workers.js,
        status: 'active',
        capabilities: {
          graphs: ['*'], // 支持所有图
        },
        lastHeartbeat: new Date(),
      });
    }

    if (workers.python) {
      await this.workerRegistry.registerWorker({
        workerId: 'worker-python-1',
        workerType: 'python',
        endpointUrl: workers.python,
        status: 'active',
        capabilities: {
          graphs: ['*'], // 支持所有图
        },
        lastHeartbeat: new Date(),
      });
    }
  }
}

// 启动服务器的便捷函数
export async function startServer(config?: Partial<ServerConfig>): Promise<AgentListServer> {
  const defaultConfig: ServerConfig = {
    port: parseInt(process.env.PORT || '8080'),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL || 'postgresql://agentlist:agentlist123@localhost:5432/agentlist',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    workers: {
      js: process.env.WORKER_JS_URL,
      python: process.env.WORKER_PYTHON_URL,
    },
    enableRateLimit: process.env.ENABLE_RATE_LIMIT !== 'false',
    enableAuth: process.env.ENABLE_AUTH === 'true',
    maxConnections: parseInt(process.env.MAX_CONNECTIONS || '20'),
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'),
  };

  const finalConfig = { ...defaultConfig, ...config };
  const server = new AgentListServer(finalConfig);
  
  await server.start();
  return server;
}

// 如果直接运行此文件，启动服务�?if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(error => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}