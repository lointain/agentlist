// Worker 注册表和管理模块
// 实现 Worker 发现、健康检查、负载均衡

export interface WorkerInfo {
  workerId: string;
  workerType: 'js' | 'python';
  endpointUrl: string;
  status: 'active' | 'inactive' | 'unhealthy';
  capabilities: {
    graphs: string[];
    maxConcurrency?: number;
    version?: string;
  };
  metrics: {
    activeTasks: number;
    totalTasks: number;
    avgResponseTime: number;
    errorRate: number;
  };
  lastHeartbeat: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkerClient {
  workerId: string;
  endpointUrl: string;
  
  // 启动运行
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  
  // 获取运行流
  getRunStream(runId: string): AsyncGenerator<RunEvent>;
  
  // 取消运行
  cancelRun(runId: string, action?: string): Promise<void>;
  
  // 健康检查
  healthCheck(): Promise<HealthStatus>;
}

export interface StartRunRequest {
  runId: string;
  threadId: string;
  graphId: string;
  checkpointUri: string;
  config: any;
  inputs: any;
  metadata: Record<string, any>;
}

export interface StartRunResponse {
  runId: string;
  status: 'accepted' | 'rejected';
  message?: string;
  streamUrl?: string;
}

export interface RunEvent {
  id: string;
  event: 'token' | 'values' | 'error' | 'done';
  data: any;
  timestamp: number;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  activeTasks: number;
  maxConcurrency: number;
  uptime: number;
  version: string;
  capabilities: string[];
}

// Worker 注册表
export class WorkerRegistry {
  private workers = new Map<string, WorkerInfo>();
  private clients = new Map<string, WorkerClient>();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly healthCheckIntervalMs: number = 30000 // 30秒
  ) {}

  // 注册 Worker
  async registerWorker(worker: Omit<WorkerInfo, 'metrics' | 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = new Date();
    const workerInfo: WorkerInfo = {
      ...worker,
      metrics: {
        activeTasks: 0,
        totalTasks: 0,
        avgResponseTime: 0,
        errorRate: 0,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.workers.set(worker.workerId, workerInfo);
    
    // 创建 Worker 客户端
    const client = this.createWorkerClient(worker.workerType, worker.endpointUrl, worker.workerId);
    this.clients.set(worker.workerId, client);

    console.log(`Worker registered: ${worker.workerId} (${worker.workerType}) at ${worker.endpointUrl}`);
  }

  // 注销 Worker
  async unregisterWorker(workerId: string): Promise<void> {
    this.workers.delete(workerId);
    this.clients.delete(workerId);
    console.log(`Worker unregistered: ${workerId}`);
  }

  // 获取所有 Worker
  getWorkers(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  // 获取健康的 Worker
  getHealthyWorkers(): WorkerInfo[] {
    return this.getWorkers().filter(w => w.status === 'active');
  }

  // 根据图 ID 获取支持的 Worker
  getWorkersForGraph(graphId: string): WorkerInfo[] {
    return this.getHealthyWorkers().filter(w => 
      w.capabilities.graphs.includes(graphId) || w.capabilities.graphs.includes('*')
    );
  }

  // 选择最优 Worker（负载均衡）
  selectWorker(graphId: string, strategy: 'round-robin' | 'least-loaded' | 'random' = 'least-loaded'): WorkerInfo | null {
    const availableWorkers = this.getWorkersForGraph(graphId);
    
    if (availableWorkers.length === 0) {
      return null;
    }

    switch (strategy) {
      case 'least-loaded':
        return availableWorkers.reduce((best, current) => 
          current.metrics.activeTasks < best.metrics.activeTasks ? current : best
        );
      
      case 'random':
        return availableWorkers[Math.floor(Math.random() * availableWorkers.length)];
      
      case 'round-robin':
        // 简单的轮询实现
        const sortedWorkers = availableWorkers.sort((a, b) => a.workerId.localeCompare(b.workerId));
        const index = Date.now() % sortedWorkers.length;
        return sortedWorkers[index];
      
      default:
        return availableWorkers[0];
    }
  }

  // 获取 Worker 客户端
  getWorkerClient(workerId: string): WorkerClient | null {
    return this.clients.get(workerId) || null;
  }

  // 更新 Worker 指标
  updateWorkerMetrics(workerId: string, metrics: Partial<WorkerInfo['metrics']>): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.metrics = { ...worker.metrics, ...metrics };
      worker.updatedAt = new Date();
    }
  }

  // 更新 Worker 心跳
  updateHeartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastHeartbeat = new Date();
      worker.status = 'active';
      worker.updatedAt = new Date();
    }
  }

  // 启动健康检查
  startHealthCheck(): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.healthCheckIntervalMs);

    console.log(`Health check started with interval: ${this.healthCheckIntervalMs}ms`);
  }

  // 停止健康检查
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log('Health check stopped');
    }
  }

  // 执行健康检查
  private async performHealthCheck(): Promise<void> {
    const workers = Array.from(this.workers.values());
    const now = new Date();

    for (const worker of workers) {
      try {
        const client = this.clients.get(worker.workerId);
        if (!client) {
          continue;
        }

        // 检查心跳超时
        const heartbeatAge = now.getTime() - worker.lastHeartbeat.getTime();
        if (heartbeatAge > this.healthCheckIntervalMs * 2) {
          worker.status = 'inactive';
          console.warn(`Worker ${worker.workerId} heartbeat timeout`);
          continue;
        }

        // 执行健康检查
        const health = await Promise.race([
          client.healthCheck(),
          new Promise<HealthStatus>((_, reject) => 
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          )
        ]);

        if (health.status === 'healthy') {
          worker.status = 'active';
          worker.metrics.activeTasks = health.activeTasks;
          worker.lastHeartbeat = now;
        } else {
          worker.status = 'unhealthy';
        }

      } catch (error) {
        worker.status = 'unhealthy';
        console.error(`Health check failed for worker ${worker.workerId}:`, error);
      }

      worker.updatedAt = now;
    }
  }

  // 创建 Worker 客户端
  private createWorkerClient(workerType: string, endpointUrl: string, workerId: string): WorkerClient {
    switch (workerType) {
      case 'js':
        return new HttpWorkerClient(endpointUrl, workerId);
      case 'python':
        return new HttpWorkerClient(endpointUrl, workerId);
      default:
        throw new Error(`Unsupported worker type: ${workerType}`);
    }
  }
}

// HTTP Worker 客户端实现
export class HttpWorkerClient implements WorkerClient {
  constructor(
    public readonly endpointUrl: string,
    public readonly workerId: string
  ) {}

  async startRun(request: StartRunRequest): Promise<StartRunResponse> {
    const response = await fetch(`${this.endpointUrl}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Worker ${this.workerId} rejected run: ${response.statusText}`);
    }

    const result = await response.json();
    return {
      runId: request.runId,
      status: 'accepted',
      streamUrl: `${this.endpointUrl}/runs/${request.runId}/stream`,
      ...result,
    };
  }

  async *getRunStream(runId: string): AsyncGenerator<RunEvent> {
    const response = await fetch(`${this.endpointUrl}/runs/${runId}/stream`, {
      headers: {
        'Accept': 'text/event-stream',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get stream for run ${runId}: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              yield {
                id: data.id || Date.now().toString(),
                event: data.event || 'data',
                data: data.data || data,
                timestamp: data.timestamp || Date.now(),
              };
            } catch (error) {
              console.error('Failed to parse SSE data:', error);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async cancelRun(runId: string, action: string = 'interrupt'): Promise<void> {
    const response = await fetch(`${this.endpointUrl}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel run ${runId}: ${response.statusText}`);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const response = await fetch(`${this.endpointUrl}/health`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return await response.json();
  }
}