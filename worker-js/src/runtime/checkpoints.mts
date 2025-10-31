// Checkpoints 运行时模块
// 说明：负责检查点的读写（Postgres），从 main.mts 中拆出以便复用与维护

import type { RuntimeDeps, RunContext } from "./types.mts";
import { checkpoints } from "../../../packages/shared-schema/src/index.mts";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq } from "drizzle-orm";

// 将检查点写入 Postgres：每个 values 事件作为一个 step
export async function writeCheckpoint(
  deps: RuntimeDeps,
  runContext: RunContext,
  stepIndex: number,
  data: any
): Promise<void> {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      if (deps.db) {
        // 使用 Drizzle 进行追加式写入
        await deps.db.insert(checkpoints).values({
          // 让数据库使用默认的 uuid_generate_v4()，无需在应用侧生成
          thread_id: runContext.threadId as any,
          run_id: runContext.runId as any,
          step_index: stepIndex,
          data: data as any,
        });
        return;
      }
      // 回退到 Pool 直接写入（兼容旧配置）
      if (!deps.pool) return;
      await deps.pool.query(
        `INSERT INTO checkpoints (checkpoint_id, thread_id, run_id, step_index, data, created_at, updated_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW(), NOW())`,
        [runContext.threadId, runContext.runId, stepIndex, JSON.stringify(data)]
      );
      return;
    } catch (err) {
      attempt++;
      deps.logger.warn(`writeCheckpoint failed (attempt ${attempt}): ${String(err)}`);
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

// 从 Postgres 读取最近检查点（用于断点续跑）
export async function readLastCheckpoint(
  deps: RuntimeDeps,
  runId: string
): Promise<{ step_index: number; data: any } | null> {
  if (deps.db) {
    const rows = await deps.db
      .select({ step_index: checkpoints.step_index, data: checkpoints.data })
      .from(checkpoints)
      .where(eq(checkpoints.run_id, runId as any))
      .orderBy(desc(checkpoints.step_index))
      .limit(1);
    if (rows.length > 0) {
      const row = rows[0];
      return { step_index: Number(row.step_index), data: row.data };
    }
    return null;
  }
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