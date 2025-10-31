// Execution 运行时模块
// 说明：封装图执行流程，包括检查点恢复、流式 events、检查点写入与状态管理

import type { RunContext } from "./types.js";
import type { RuntimeDeps } from "./types.js";
import { emitEvent } from "./events.js";
import { writeCheckpoint, readLastCheckpoint } from "./checkpoints.js";

// 执行图并进行流式事件输出与检查点持久化
export async function executeGraph(
  deps: RuntimeDeps,
  runContext: RunContext,
  request: {
    inputs?: any;
    metadata?: Record<string, any>;
    config?: any;
    threadId: string;
    runId: string;
  }
): Promise<void> {
  const { runId, graph, abortController } = runContext;
  const { logger } = deps;

  try {
    logger.info(`Starting graph execution for run ${runId}`);

    // 尝试恢复：当同一 runId 存在检查点时，回放最近 values 作为初始输入
    // 若未提供 inputs，则默认使用空对象；随后若发现检查点会覆盖
    let startingInputs = request.inputs ?? {};
    try {
      const last = await readLastCheckpoint(deps, request.runId);
      if (last && last.data && last.data.values !== undefined) {
        startingInputs = last.data.values;
        runContext.stepIndex = (last.step_index ?? 0) + 1;
        emitEvent(deps, runContext, "resume", {
          stepIndex: runContext.stepIndex,
        });
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
        ...(request.config?.configurable ?? {}),
      },
      signal: abortController.signal,
    };

    // 执行图并流式输出结果
    const stream = await graph.stream(startingInputs, config);

    for await (const chunk of stream) {
      // 检查是否被取消
      if (abortController.signal.aborted) {
        runContext.status = "cancelled";
        break;
      }

      // 发送中间结果事件
      emitEvent(deps, runContext, "values", chunk);
      // 写入检查点到 Postgres（基于当前步索引）
      try {
        await writeCheckpoint(deps, runContext, runContext.stepIndex, {
          values: chunk,
          metadata: request.metadata ?? {},
        });
        runContext.stepIndex += 1;
      } catch (err) {
        logger.error(
          `写入检查点失败 run=${runId} step=${runContext.stepIndex}:`,
          err
        );
      }
    }

    if (runContext.status === "running") {
      runContext.status = "completed";
      emitEvent(deps, runContext, "done", { runId });
    }
  } catch (error: any) {
    if (abortController.signal.aborted) {
      runContext.status = "cancelled";
      emitEvent(deps, runContext, "error", {
        message: "Run was cancelled",
        action: abortController.signal.reason,
      });
    } else {
      runContext.status = "failed";
      emitEvent(deps, runContext, "error", {
        message: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
