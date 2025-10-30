// 系统指标路由模块
// 说明：从 server.mts 抽离 /metrics 路由
import { Hono } from "hono";

export function registerMetricsRoutes(app: Hono): void {
  // 队列深度（pending runs 数量）
  app.get("/metrics/queue-depth", async (c) => {
    const postgres = c.get("postgres");
    const pendingRuns = await postgres.runs.search({ status: ["pending"], limit: 1000 });
    return c.json({ queueDepth: pendingRuns.length, timestamp: new Date().toISOString() });
  });

  // Worker 状态聚合指标
  app.get("/metrics/workers", (c) => {
    const registry = c.get("workerRegistry");
    const workers = registry.getWorkers();
    const metrics = workers.map((w: any) => ({
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