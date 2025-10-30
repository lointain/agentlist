// Worker 运行时生命周期模块
// 说明：将注册协调器与心跳逻辑从 main.mts 抽离为可复用函数
// 这样 main.mts 聚焦路由与装配，生命周期细节统一在此维护。

import type { RuntimeDeps, WorkerConfig } from "./types.mts";

/**
 * 注册当前 Worker 到 Orchestrator。
 * - 兼容 body.url 与 body.endpointUrl 两种字段（协调器端已兼容）。
 * - 仅在配置了 orchestratorUrl 时生效。
 */
export async function registerWithOrchestrator(config: WorkerConfig, deps: RuntimeDeps): Promise<void> {
  const { logger } = deps;
  if (!config.orchestratorUrl) {
    logger.info("No orchestrator URL configured, skipping registration");
    return;
  }

  try {
    const response = await fetch(`${config.orchestratorUrl}/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: config.workerId,
        workerType: "js",
        // 同时传递两种字段名，确保兼容不同版本的后端
        url: `http://${config.host}:${config.port}`,
        endpointUrl: `http://${config.host}:${config.port}`,
        status: "active",
        capabilities: config.capabilities,
        lastHeartbeat: new Date(),
      }),
    });

    if (response.ok) {
      logger.info(`Successfully registered with orchestrator: ${config.orchestratorUrl}`);
    } else {
      logger.error(`Failed to register with orchestrator: ${response.statusText}`);
    }
  } catch (error) {
    logger.error("Error registering with orchestrator:", error);
  }
}

/**
 * 启动与 Orchestrator 的心跳。
 * - 周期性向 /workers/:workerId/heartbeat 发送 POST 请求。
 * - 返回计时器句柄，便于后续停止。
 */
export function startHeartbeat(config: WorkerConfig, deps: RuntimeDeps): NodeJS.Timeout | null {
  const { logger } = deps;
  if (!config.orchestratorUrl) {
    return null;
  }
  const timer = setInterval(async () => {
    try {
      const response = await fetch(`${config.orchestratorUrl}/workers/${config.workerId}/heartbeat`, { method: "POST" });
      if (!response.ok) {
        logger.warn(`Heartbeat failed: ${response.statusText}`);
      }
    } catch (error) {
      logger.error("Heartbeat error:", error);
    }
  }, config.heartbeatInterval);
  return timer;
}

/**
 * 停止心跳计时器。
 */
export function stopHeartbeat(timer: NodeJS.Timeout | null): void {
  if (timer) {
    clearInterval(timer);
  }
}