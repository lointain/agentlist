// Worker 管理路由模块
// 说明：从 server.mts 抽离 /workers 系列路由（注册、列表、健康）
import { Hono } from "hono";
import crypto from "node:crypto";
import { logger } from "../../logging.mts";

export function registerWorkerRoutes(app: Hono): void {
  // 注册 Worker
  app.post("/workers/register", async (c) => {
    try {
      const body = await c.req.json();
      const workerId: string = body.workerId || crypto.randomUUID();
      const workerType: string = body.workerType || "js";
      // 兼容字段：支持 url 或 endpointUrl
      const url: string = body.url || body.endpointUrl;
      if (!url) {
        return c.json({ error: "Missing worker url" }, 400);
      }
      const registry = c.get("workerRegistry");
      registry.registerWorker({ workerId, workerType, url });
      return c.json({ workerId, workerType, url }, 201);
    } catch (error) {
      logger.error("Failed to register worker:", error);
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Worker 列表
  app.get("/workers", (c) => {
    const registry = c.get("workerRegistry");
    const workers = registry.getWorkers();
    return c.json(workers);
  });

  // Worker 健康
  app.get("/workers/:workerId/health", (c) => {
    const registry = c.get("workerRegistry");
    const workerId = c.req.param("workerId");
    const worker = registry
      .getWorkers()
      .find((w: any) => w.workerId === workerId);
    if (!worker) return c.json({ error: "Worker not found" }, 404);
    return c.json({ workerId, status: worker.status });
  });

  // Worker 心跳：提供 200 响应以避免 Worker 报警；
  // 若注册表支持触发心跳更新，则尽量调用（可选）。
  app.post("/workers/:workerId/heartbeat", (c) => {
    try {
      const workerId = c.req.param("workerId");
      const registry = c.get("workerRegistry");
      // 可选更新：若存在 touch/updateHeartbeat 方法则调用
      const maybeTouch =
        (registry as any).touchWorker || (registry as any).updateHeartbeat;
      if (typeof maybeTouch === "function") {
        try {
          maybeTouch.call(registry, workerId);
        } catch {}
      }
      return c.json({
        ok: true,
        workerId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn("Worker heartbeat handling failed:", error);
      return c.json({ ok: false }, 200);
    }
  });
}
