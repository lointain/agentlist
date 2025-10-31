// Checkpoints 运行时模块
// 说明：负责检查点的读写（Postgres），从 main.mts 中拆出以便复用与维护

import type { RuntimeDeps, RunContext } from "./types.js";
import { v4 as uuidv4 } from "uuid";

// 将检查点写入 Postgres：每个 values 事件作为一个 step
export async function writeCheckpoint(
  deps: RuntimeDeps,
  runContext: RunContext,
  stepIndex: number,
  data: any
): Promise<void> {
  // 检查 deps.pool 是否存在
  if (!deps.pool) {
    deps.logger.warn(
      "Database pool is not available, skipping checkpoint write."
    );
    return;
  }
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      // 使用原生 SQL 进行追加式写入
      await deps.pool.query(
        `INSERT INTO checkpoints (checkpoint_id, thread_id, run_id, step_index, data) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), runContext.threadId, runContext.runId, stepIndex, data]
      );
      return;
    } catch (err) {
      attempt++;
      deps.logger.warn(
        `writeCheckpoint failed (attempt ${attempt}): ${String(err)}`
      );
      await new Promise<void>((r) => setTimeout(r, 100 * attempt));
    }
  }
}

// 从 Postgres 读取最近检查点（用于断点续跑）
export async function readLastCheckpoint(
  deps: RuntimeDeps,
  runId: string
): Promise<{ step_index: number; data: any } | null> {
  // 检查 deps.pool 是否存在
  if (!deps.pool) {
    deps.logger.warn(
      "Database pool is not available, skipping checkpoint read."
    );
    return null;
  }
  const result = await deps.pool.query(
    `SELECT step_index, data FROM checkpoints WHERE run_id = $1 ORDER BY step_index DESC LIMIT 1`,
    [runId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return { step_index: Number(row.step_index), data: row.data };
  }
  return null;
}
