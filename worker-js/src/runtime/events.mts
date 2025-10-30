// Events 运行时模块
// 说明：负责事件发射/持久化与 SSE 历史转发，从 main.mts 中拆出以便复用与维护

import type { RuntimeDeps, RunContext } from "./types.mts";

// 写事件到 Postgres 的 events 表（保持与 main.mts 相同的列名与语义）
export async function writeEvent(
  deps: RuntimeDeps,
  runId: string,
  type: string,
  data: any
): Promise<void> {
  if (!deps.pool) return;
  await deps.pool.query(
    `INSERT INTO events (event_id, run_id, type, data, created_at) VALUES (uuid_generate_v4(), $1, $2, $3, NOW())`,
    [runId, type, JSON.stringify(data)]
  );
}

// 读取某个 run 的历史事件（按时间顺序）
export async function readEvents(
  deps: RuntimeDeps,
  runId: string
): Promise<Array<{ event: string; data: any; timestamp: number }>> {
  if (!deps.pool) return [];
  const res = await deps.pool.query(
    `SELECT type AS event, data, extract(epoch from created_at)*1000 AS timestamp FROM events WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId]
  );
  return res.rows.map((r) => ({ event: r.event, data: r.data, timestamp: Number(r.timestamp) }));
}

// 事件发射：写入内存缓冲、SSE 推送，并持久化
export function emitEvent(
  deps: RuntimeDeps,
  runContext: RunContext,
  event: string,
  data: any
): void {
  const payload = { event, data, timestamp: Date.now() };
  runContext.events.push(payload);
  for (const controller of runContext.sseControllers) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(new TextEncoder().encode(line));
  }
  // 异步持久化
  writeEvent(deps, runContext.runId, event, data).catch((err) => {
    deps.logger.warn(`writeEvent failed: ${String(err)}`);
  });
}

// SSE 流式回放历史事件并跟随实时更新
export async function streamRunEvents(
  deps: RuntimeDeps,
  runContext: RunContext,
  controller: ReadableStreamDefaultController
): Promise<void> {
  // 先回放历史
  const persisted = await readEvents(deps, runContext.runId);
  for (const e of persisted) {
    const line = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
    controller.enqueue(new TextEncoder().encode(line));
  }

  // 推送开始事件（与原有逻辑保持一致）
  const startPayload = { event: "start", data: { runId: runContext.runId } };
  const line = `event: ${startPayload.event}\ndata: ${JSON.stringify(startPayload.data)}\n\n`;
  controller.enqueue(new TextEncoder().encode(line));
  writeEvent(deps, runContext.runId, "start", startPayload.data).catch(() => {});

  // 注册 SSE controller
  runContext.sseControllers.add(controller);
  const cleanup = () => runContext.sseControllers.delete(controller);
  // 主动关闭的一致行为
  const checkEnd = () => {
    if (runContext.status !== "running") {
      const endPayload = { event: runContext.status, data: { runId: runContext.runId } };
      const endLine = `event: ${endPayload.event}\ndata: ${JSON.stringify(endPayload.data)}\n\n`;
      controller.enqueue(new TextEncoder().encode(endLine));
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