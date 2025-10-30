// Checkpoints 运行时模块
// 说明：负责检查点的读写（Postgres），从 main.mts 中拆出以便复用与维护

import type { RuntimeDeps, RunContext } from "./types.mts";

// 将检查点写入 Postgres：每个 values 事件作为一个 step
export async function writeCheckpoint(
  deps: RuntimeDeps,
  runContext: RunContext,
  stepIndex: number,
  data: any
): Promise<void> {
  if (!deps.pool) return;
  await deps.pool.query(
    `INSERT INTO checkpoints (checkpoint_id, thread_id, run_id, step_index, data, created_at, updated_at)
     VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW(), NOW())`,
    [runContext.threadId, runContext.runId, stepIndex, JSON.stringify(data)]
  );
}

// 从 Postgres 读取最近检查点（用于断点续跑）
export async function readLastCheckpoint(
  deps: RuntimeDeps,
  runId: string
): Promise<{ step_index: number; data: any } | null> {
  if (!deps.pool) return null;
  const res = await deps.pool.query(
    `SELECT step_index, data FROM checkpoints WHERE run_id = $1 ORDER BY step_index DESC LIMIT 1`,
    [runId]
  );
  if (res && typeof res.rowCount === "number" && res.rowCount > 0) {
    const row = res.rows[0];
    return { step_index: Number(row.step_index), data: row.data };
  }
  return null;
}