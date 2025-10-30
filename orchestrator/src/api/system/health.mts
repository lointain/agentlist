// 系统健康检查路由模块
// 说明：从 server.mts 抽离 /health 路由，server.mts 负责装配即可
import { Hono } from "hono";
import { logger } from "../../logging.mts";

export function registerHealthRoutes(app: Hono): void {
  app.get("/health", async (c) => {
    try {
      const postgres = c.get("postgres");
      const redisStreams = c.get("redisStreams");
      const workerRegistry = c.get("workerRegistry");
      await postgres.runs.search({ limit: 1 });
      // @ts-expect-error 内部实现：从管理器暴露 redis 实例
      await redisStreams["redis"].ping();
      const workers = workerRegistry.getWorkers();
      const healthyWorkers = workerRegistry.getHealthyWorkers();
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
}