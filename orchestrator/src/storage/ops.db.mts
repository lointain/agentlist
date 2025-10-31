// Database-backed Ops 实现：使用 Postgres 存储 + Redis Streams 流式事件
// 目标：替换 FileSystemOps / StreamManagerImpl，保留现有接口以兼容 API 与队列

import type {
  Ops,
  AssistantsRepo,
  ThreadsRepo,
  RunsRepo,
  RunsStreamRepo,
  Run,
  RunStatus,
  Metadata,
  AuthContext,
} from "./types.mts";
import { PostgresAdapter } from "./postgres.mts";
import {
  RedisStreamManager,
  RedisLockManager,
  RedisCancellationManager,
} from "./redis-streams.mts";

// DatabaseOps 聚合：对外暴露与 FileSystemOps 相同的接口，但内部使用 Postgres/Redis
export class DatabaseOps implements Ops {
  readonly assistants: AssistantsRepo;
  readonly threads: ThreadsRepo;
  readonly runs: RunsRepo;

  constructor(
    private readonly pg: PostgresAdapter,
    private readonly streams: RedisStreamManager,
    private readonly locks: RedisLockManager,
    private readonly cancel: RedisCancellationManager
  ) {
    // 使用组合以复用 PostgresAdapter 的具体实现
    this.assistants = pg.assistants;
    this.threads = pg.threads;
    this.runs = new DatabaseRuns(pg, streams, locks, cancel);
  }

  // 按需清理（数据库/Redis）——此处最小实现：交由外部工具或迁移脚本处理
  async truncate(flags: {
    runs?: boolean;
    threads?: boolean;
    assistants?: boolean;
    checkpointer?: boolean;
    store?: boolean;
  }): Promise<void> {
    // 简化：不直接在此执行数据清理，避免误删生产数据
    // 可扩展为调用专用维护脚本（例如 TRUNCATE TABLE / 清理 Redis key）
    return Promise.resolve();
  }
}

// Runs 仓库：包装 PostgresRuns，并为 join/publish/cancel/next 提供 Redis 集成
class DatabaseRuns implements RunsRepo {
  readonly stream: RunsStreamRepo;

  constructor(
    private readonly pg: PostgresAdapter,
    private readonly streams: RedisStreamManager,
    private readonly locks: RedisLockManager,
    private readonly cancel: RedisCancellationManager
  ) {
    this.stream = new RedisRunsStream(this.streams);
  }

  // 统一委托到 PostgresAdapter 实现
  async put(
    runId: string,
    assistantId: string,
    kwargs: any,
    options: {
      threadId?: string;
      userId?: string;
      status?: RunStatus;
      metadata?: Metadata;
      preventInsertInInflight?: boolean;
      multitaskStrategy?: any;
      ifNotExists?: any;
      afterSeconds?: number;
    },
    auth: AuthContext | undefined
  ): Promise<Run[]> {
    return this.pg.runs.put(runId, assistantId, kwargs, options as any, auth);
  }

  async *next(): AsyncGenerator<{
    run: Run;
    attempt: number;
    signal: AbortSignal;
  }> {
    // 复用 PostgresRuns.next() 的选取逻辑，但增强取消信号（Redis + 原始信号）
    for await (const { run, attempt, signal } of this.pg.runs.next()) {
      const controller = new AbortController();

      // 原始数据库信号 -> 转发到 controller
      signal.addEventListener(
        "abort",
        () => {
          controller.abort(signal.reason as any);
        },
        { once: true }
      );

      // 订阅 Redis 取消信号（interrupt/rollback），收到后中止执行
      const unsubscribe = await this.cancel.subscribeCancelSignal(
        run.run_id,
        (action) => {
          controller.abort(action as any);
        }
      );

      // 将组合后的信号传递给 worker
      try {
        yield { run, attempt, signal: controller.signal };
      } finally {
        // 清理订阅
        await unsubscribe();
      }
    }
  }

  async get(
    runId: string,
    _threadId: string | undefined,
    _auth: AuthContext | undefined
  ): Promise<Run | null> {
    return this.pg.runs.get(runId);
  }

  async delete(
    run_id: string,
    _thread_id: string | undefined,
    _auth: AuthContext | undefined
  ): Promise<string | null> {
    // 简化：直接标记为取消或删除逻辑可由业务约束决定，这里使用取消
    await this.pg.runs.updateStatus(run_id, "cancelled");
    return run_id;
  }

  async wait(
    runId: string,
    _threadId: string | undefined,
    _auth: AuthContext | undefined
  ): Promise<unknown> {
    // 最小实现：等待完成可通过轮询状态或订阅 Redis 事件完成
    // 这里轮询 DB 状态，生产中可优化为使用通知/事件
    for (let i = 0; i < 300; i++) {
      const run = await this.pg.runs.get(runId);
      if (
        run &&
        ["success", "error", "timeout", "interrupted"].includes(
          run.status as any
        )
      ) {
        return run.status;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  async join(
    runId: string,
    _threadId: string,
    _auth: AuthContext | undefined
  ): Promise<unknown> {
    // 最小实现：直接返回状态（兼容 API 的 /join 行为），更复杂可返回检查点等
    const run = await this.pg.runs.get(runId);
    return run;
  }

  async setStatus(runId: string, status: RunStatus): Promise<unknown> {
    await this.pg.runs.updateStatus(runId, status as any);
    return true;
  }

  async cancel(
    threadId: string | undefined,
    runIds: string[],
    options: { action?: "interrupt" | "rollback" },
    _auth: AuthContext | undefined
  ): Promise<void> {
    const action = options.action ?? "interrupt";
    for (const runId of runIds) {
      // 通知 Redis（Pub/Sub + 取消标记），worker 中的信号会被触发
      await this.cancel.sendCancelSignal(runId, action);
      // 更新数据库状态
      await this.pg.runs.updateStatus(runId, "cancelled", { action, threadId });
    }
  }

  async search(
    threadId: string,
    options: {
      limit?: number | null;
      offset?: number | null;
      status?: string | null;
      metadata?: Metadata | null;
    },
    _auth: AuthContext | undefined
  ): Promise<Run[]> {
    // 转换参数适配 PostgresRuns.search
    return this.pg.runs.search({
      threadId,
      status: options.status ? [options.status] : undefined,
      limit: options.limit ?? undefined,
      offset: options.offset ?? undefined,
    } as any);
  }
}

// Redis 流式接口实现：替代 FileSystemRuns.Stream
class RedisRunsStream implements RunsStreamRepo {
  constructor(private readonly streams: RedisStreamManager) {}

  async *join(
    runId: string,
    _threadId: string | undefined,
    options: {
      ignore404?: boolean;
      cancelOnDisconnect?: AbortSignal;
      lastEventId: string | undefined;
    },
    _auth: AuthContext | undefined
  ): AsyncGenerator<{ id?: string; event: string; data: unknown }> {
    // 如果需要断点续传，先回放历史（当 lastEventId = '-1' 或具体 ID 时）
    if (options.lastEventId && options.lastEventId !== "0") {
      const history = await this.streams.getHistory(runId, {
        startId: options.lastEventId,
      });
      for (const evt of history) {
        yield { id: evt.id, event: evt.event, data: evt.data };
      }
    }

    // 实时消费 Redis Streams 事件
    const startId = options.lastEventId ?? "0";
    const consumer = this.streams.consume(runId, {
      startId,
      batchSize: 50,
      blockTime: 1000,
    });

    const abort = options.cancelOnDisconnect;
    try {
      for await (const evt of consumer) {
        if (abort?.aborted) break;
        yield { id: evt.id, event: evt.event, data: evt.data };
      }
    } finally {
      // 流结束：可选清理逻辑（此处不需要显式关闭）
    }
  }

  async publish(payload: {
    runId: string;
    resumable: boolean;
    event: string;
    data: unknown | Error;
  }): Promise<void> {
    // 将事件写入 Redis Streams；保留 data 原样（已在调用方序列化 error）
    await this.streams.publish(payload.runId, payload.event, payload.data);
  }
}
