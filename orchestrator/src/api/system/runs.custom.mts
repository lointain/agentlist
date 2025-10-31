// 自定义运行 API 模块
// 说明：从 server.mts 抽离自定义运行创建与 SSE 转发（与原逻辑保持一致）
import { Hono } from "hono";
import crypto from "node:crypto";
import { logger } from "../../logging.mts";

export function registerCustomRunsRoutes(app: Hono, databaseUrl: string): void {
  // 创建运行
  app.post("/threads/:threadId/runs", async (c) => {
    try {
      const threadId = c.req.param("threadId");
      const body = await c.req.json();
      const { assistant_id, input, config, metadata } = body;

      const postgres = c.get("postgres");
      const registry = c.get("workerRegistry");

      const assistant = await postgres.assistants.get(assistant_id);
      if (!assistant) return c.json({ error: "Assistant not found" }, 404);

      const worker = registry.selectWorker(assistant.graph_id);
      if (!worker)
        return c.json(
          { error: `No worker for graph ${assistant.graph_id}` },
          503
        );

      const runId = crypto.randomUUID();
      await postgres.runs.put(
        runId,
        assistant_id,
        { input, config },
        {
          threadId,
          status: "pending",
          metadata: {
            ...metadata,
            workerId: worker.workerId,
            workerType: worker.workerType,
          },
        }
      );

      const workerClient = registry.getWorkerClient(worker.workerId);
      if (workerClient) {
        try {
          await workerClient.startRun({
            runId,
            threadId,
            graphId: assistant.graph_id,
            checkpointUri: databaseUrl,
            config: { ...assistant.config, ...config },
            inputs: input,
            metadata: metadata || {},
          });
          await postgres.runs.updateStatus(runId, "running");
          registry.updateWorkerMetrics(worker.workerId, {
            activeTasks: (worker.metrics?.activeTasks ?? 0) + 1,
            totalTasks: (worker.metrics?.totalTasks ?? 0) + 1,
          });
        } catch (err) {
          logger.error(`Start run failed on worker ${worker.workerId}:`, err);
          await postgres.runs.updateStatus(runId, "failed", {
            error: err instanceof Error ? err.message : "Worker error",
          });
        }
      }

      return c.json({ run_id: runId }, 201);
    } catch (error) {
      logger.error("Failed to create run:", error);
      return c.json(
        { error: error instanceof Error ? error.message : "Internal error" },
        500
      );
    }
  });

  // 获取运行事件流（SSE 转发）
  app.get("/threads/:threadId/runs/:runId/stream", async (c) => {
    const runId = c.req.param("runId");
    try {
      const postgres = c.get("postgres");
      const registry = c.get("workerRegistry");
      const run = await postgres.runs.get(runId);
      if (!run) return c.json({ error: "Run not found" }, 404);
      const workerId = run.metadata?.workerId;
      if (!workerId) return c.json({ error: "No worker assigned" }, 400);
      const workerClient = registry.getWorkerClient(workerId);
      if (!workerClient) return c.json({ error: "Worker not available" }, 503);

      // SSE 响应头
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      // 透传 Worker 的事件流
      const stream = await workerClient.streamRunEvents(runId);
      return c.newResponse(stream, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    } catch (error) {
      logger.error("Stream run events failed:", error);
      return c.json(
        { error: error instanceof Error ? error.message : "Internal error" },
        500
      );
    }
  });
}
