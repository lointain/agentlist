// PostgreSQL 存储适配器 - 高并发优化版本
// 基于 13-多用户高并发与持久化优化报告.md 的设计

import { Pool, PoolClient } from "pg";
// 引入 Drizzle ORM（Node-Postgres 驱动）与表结构
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, and, sql, inArray } from "drizzle-orm";
import {
  assistants as tblAssistants,
  threads as tblThreads,
  runs as tblRuns,
} from "./schema.mts";
import type {
  RunsRepo,
  ThreadsRepo,
  AssistantsRepo,
  Run,
  Thread,
  Assistant,
  RunnableConfig,
  Metadata,
} from "../storage/types.mts";

export interface PostgresConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class PostgresAdapter {
  public readonly pool: Pool;
  // Drizzle 数据库实例（基于当前连接池）
  private db: NodePgDatabase;

  constructor(config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 20,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2000,
    });
    // 初始化 Drizzle 数据库实例
    this.db = drizzle(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  get runs(): RunsRepo {
    return new PostgresRuns(this.pool, this.db);
  }

  get threads(): ThreadsRepo {
    return new PostgresThreads(this.pool, this.db);
  }

  get assistants(): AssistantsRepo {
    return new PostgresAssistants(this.pool, this.db);
  }

  // 可选：暴露 checkpoints 仓库（当前未在 Ops 中使用）
  // get checkpoints() { return new PostgresCheckpoints(this.db); }
}

// PostgreSQL Runs 实现 - 支持高并发调度
export class PostgresRuns implements RunsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly db: NodePgDatabase
  ) {}

  // 幂等插入：利用唯一索引 (run_id) + UPSERT
  async put(
    runId: string,
    assistantId: string,
    kwargs: any,
    options: {
      threadId?: string;
      status?: string;
      metadata?: Metadata;
      afterSeconds?: number;
      multitaskStrategy?: string;
      ifNotExists?: boolean;
    } = {},
    auth?: any
  ): Promise<Run[]> {
    // 1) 确保线程存在：使用 Drizzle onConflictDoNothing
    if (options.threadId) {
      await this.db
        .insert(tblThreads)
        .values({
          thread_id: options.threadId,
          status: "idle",
          config: {},
          metadata: options.metadata ?? {},
          created_at: new Date(),
          updated_at: new Date(),
        })
        .onConflictDoNothing({ target: tblThreads.thread_id });
    }

    // 2) 如果要求不重复插入，先查存在
    if (options.ifNotExists) {
      const exists = await this.db
        .select({ run_id: tblRuns.run_id })
        .from(tblRuns)
        .where(eq(tblRuns.run_id, runId));
      if (exists.length > 0) {
        return this.getRunsByThread(options.threadId!);
      }
    }

    // 3) 多任务策略：reject 时检测该线程是否已有在途任务（保持原生 SQL，性能更优）
    if (options.multitaskStrategy === "reject" && options.threadId) {
      const runningRuns = await this.db
        .select({ run_id: tblRuns.run_id })
        .from(tblRuns)
        .where(
          and(
            eq(tblRuns.thread_id, options.threadId),
            inArray(tblRuns.status, ["pending", "running"]) as any
          )
        )
        .limit(1);
      if (runningRuns.length > 0) {
        throw new Error(`Thread ${options.threadId} already has running tasks`);
      }
    }

    // 4) 插入/更新 run（幂等）——使用 Drizzle upsert
    const scheduled_at = options.afterSeconds
      ? new Date(Date.now() + options.afterSeconds * 1000)
      : new Date();

    await this.db
      .insert(tblRuns)
      .values({
        run_id: runId,
        thread_id: options.threadId!,
        assistant_id: assistantId,
        status: options.status ?? "pending",
        kwargs: kwargs ?? {},
        metadata: options.metadata ?? {},
        scheduled_at,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: tblRuns.run_id,
        set: {
          status: options.status ?? "pending",
          kwargs: kwargs ?? {},
          metadata: options.metadata ?? {},
          updated_at: new Date(),
        },
      });

    // 返回该线程的在途 run 列表
    return this.getRunsByThread(options.threadId!);
  }

  // 安全调度：一次性锁定一批待处理 run，避免多工作者抢占
  async *next(): AsyncGenerator<{
    run: Run;
    attempt: number;
    signal: AbortSignal;
  }> {
    while (true) {
      try {
        const selected = await this.db.transaction(async (tx) => {
          // 使用 SKIP LOCKED 避免锁等待，提升并发调度
          const res = await tx.execute(sql`
            SELECT r.*, a.graph_id, a.config as assistant_config
            FROM runs r
            JOIN assistants a ON r.assistant_id = a.id
            WHERE r.status = 'pending'
              AND r.scheduled_at <= NOW()
              AND NOT EXISTS (
                SELECT 1 FROM runs r2
                WHERE r2.thread_id = r.thread_id
                  AND r2.status = 'running'
              )
            ORDER BY r.created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 10
          `);

          if ((res as any).rowCount === 0) {
            return [] as any[];
          }

          const rows = (res as any).rows as any[];
          for (const row of rows) {
            const runId = row.run_id as string;
            await tx.execute(sql`
              UPDATE runs SET
                status = 'running',
                attempt = attempt + 1,
                started_at = NOW(),
                updated_at = NOW()
              WHERE run_id = ${runId}
            `);
          }
          return rows;
        });

        if (!selected || selected.length === 0) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

        for (const row of selected) {
          const runId = row.run_id as string;
          const controller = new AbortController();
          yield {
            run: {
              run_id: runId,
              thread_id: row.thread_id,
              assistant_id: row.assistant_id,
              status: "running",
              kwargs: row.kwargs,
              metadata: row.metadata,
              graph_id: row.graph_id,
              config: row.assistant_config,
              attempt: (row.attempt ?? 0) + 1,
              created_at: row.created_at,
              updated_at: new Date(),
            } as Run,
            attempt: (row.attempt ?? 0) + 1,
            signal: controller.signal,
          };
        }
      } catch (e) {
        throw e;
      }
    }
  }

  async get(runId: string): Promise<Run | null> {
    // 用 Drizzle 执行联表查询
    const rows = await this.db
      .select({
        run_id: tblRuns.run_id,
        thread_id: tblRuns.thread_id,
        assistant_id: tblRuns.assistant_id,
        status: tblRuns.status,
        kwargs: tblRuns.kwargs,
        metadata: tblRuns.metadata,
        attempt: tblRuns.attempt,
        created_at: tblRuns.created_at,
        updated_at: tblRuns.updated_at,
        graph_id: tblAssistants.graph_id,
        assistant_config: tblAssistants.config,
      })
      .from(tblRuns)
      .innerJoin(tblAssistants, eq(tblRuns.assistant_id, tblAssistants.id))
      .where(eq(tblRuns.run_id, runId))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      run_id: row.run_id as unknown as string,
      thread_id: row.thread_id as unknown as string,
      assistant_id: row.assistant_id as unknown as string,
      status: row.status as unknown as string,
      kwargs: row.kwargs as any,
      metadata: row.metadata as any,
      graph_id: row.graph_id as unknown as string,
      config: row.assistant_config as any,
      attempt: row.attempt as number,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as Run;
  }

  async updateStatus(
    runId: string,
    status: string,
    metadata?: Metadata
  ): Promise<void> {
    const set: any = { status, updated_at: new Date() };
    if (metadata) set.metadata = metadata as any;
    if (["completed", "failed", "cancelled"].includes(status)) {
      set.completed_at = new Date();
    }
    await this.db.update(tblRuns).set(set).where(eq(tblRuns.run_id, runId));
  }

  async search(
    options: {
      threadId?: string;
      assistantId?: string;
      status?: string[];
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Run[]> {
    const {
      threadId,
      assistantId,
      status = [],
      limit = 50,
      offset = 0,
    } = options;
    const whereParts = [] as any[];
    if (threadId) whereParts.push(eq(tblRuns.thread_id, threadId));
    if (assistantId) whereParts.push(eq(tblRuns.assistant_id, assistantId));
    if (status.length > 0) whereParts.push(inArray(tblRuns.status, status));

    const rows = await this.db
      .select({
        run_id: tblRuns.run_id,
        thread_id: tblRuns.thread_id,
        assistant_id: tblRuns.assistant_id,
        status: tblRuns.status,
        kwargs: tblRuns.kwargs,
        metadata: tblRuns.metadata,
        attempt: tblRuns.attempt,
        created_at: tblRuns.created_at,
        updated_at: tblRuns.updated_at,
        graph_id: tblAssistants.graph_id,
        assistant_config: tblAssistants.config,
      })
      .from(tblRuns)
      .innerJoin(tblAssistants, eq(tblRuns.assistant_id, tblAssistants.id))
      .where(
        whereParts.length
          ? whereParts.reduce(
              (acc, cur) => (acc ? sql`${acc} AND ${cur}` : cur),
              undefined as any
            )
          : undefined
      )
      .orderBy(sql`r.created_at DESC`)
      .limit(limit)
      .offset(offset);

    return rows.map((row) => ({
      run_id: row.run_id as string,
      thread_id: row.thread_id as string,
      assistant_id: row.assistant_id as string,
      status: row.status as string,
      kwargs: row.kwargs as any,
      metadata: row.metadata as any,
      graph_id: row.graph_id as string,
      config: row.assistant_config as any,
      attempt: row.attempt as number,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    })) as Run[];
  }

  private async getRunsByThread(
    threadId: string,
    client?: PoolClient
  ): Promise<Run[]> {
    const rows = await this.db
      .select({
        run_id: tblRuns.run_id,
        thread_id: tblRuns.thread_id,
        assistant_id: tblRuns.assistant_id,
        status: tblRuns.status,
        kwargs: tblRuns.kwargs,
        metadata: tblRuns.metadata,
        attempt: tblRuns.attempt,
        created_at: tblRuns.created_at,
        updated_at: tblRuns.updated_at,
        graph_id: tblAssistants.graph_id,
        assistant_config: tblAssistants.config,
      })
      .from(tblRuns)
      .innerJoin(tblAssistants, eq(tblRuns.assistant_id, tblAssistants.id))
      .where(
        and(
          eq(tblRuns.thread_id, threadId),
          inArray(tblRuns.status, ["pending", "running"])
        )
      )
      .orderBy(sql`r.created_at ASC`);

    return rows.map((row) => ({
      run_id: row.run_id as string,
      thread_id: row.thread_id as string,
      assistant_id: row.assistant_id as string,
      status: row.status as string,
      kwargs: row.kwargs as any,
      metadata: row.metadata as any,
      graph_id: row.graph_id as string,
      config: row.assistant_config as any,
      attempt: row.attempt as number,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    })) as Run[];
  }
}

// PostgreSQL Threads 实现
export class PostgresThreads implements ThreadsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly db: NodePgDatabase
  ) {}

  async get(threadId: string): Promise<Thread | null> {
    const rows = await this.db
      .select({
        thread_id: tblThreads.thread_id,
        status: tblThreads.status,
        config: tblThreads.config,
        metadata: tblThreads.metadata,
        created_at: tblThreads.created_at,
        updated_at: tblThreads.updated_at,
      })
      .from(tblThreads)
      .where(eq(tblThreads.thread_id, threadId))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      thread_id: row.thread_id,
      status: row.status as string,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as Thread;
  }

  async put(
    threadId: string,
    config: RunnableConfig,
    metadata?: Metadata
  ): Promise<Thread> {
    const rows = await this.db
      .insert(tblThreads)
      .values({
        thread_id: threadId,
        config: config as any,
        metadata: (metadata ?? {}) as any,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: tblThreads.thread_id,
        set: {
          config: config as any,
          metadata: (metadata ?? {}) as any,
          updated_at: new Date(),
        },
      })
      .returning({
        thread_id: tblThreads.thread_id,
        status: tblThreads.status,
        config: tblThreads.config,
        metadata: tblThreads.metadata,
        created_at: tblThreads.created_at,
        updated_at: tblThreads.updated_at,
      });

    const row = rows[0];
    return {
      thread_id: row.thread_id,
      status: row.status as string,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as Thread;
  }

  async updateStatus(threadId: string, status: string): Promise<void> {
    await this.db
      .update(tblThreads)
      .set({ status, updated_at: new Date() })
      .where(eq(tblThreads.thread_id, threadId));
  }

  async search(
    options: {
      status?: string;
      metadata?: Record<string, any>;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Thread[]> {
    const { status, metadata, limit = 50, offset = 0 } = options;
    const whereParts = [] as any[];
    if (status) whereParts.push(eq(tblThreads.status, status));
    if (metadata)
      whereParts.push(
        sql`${tblThreads.metadata} @> ${JSON.stringify(metadata)}::jsonb`
      );

    const rows = await this.db
      .select({
        thread_id: tblThreads.thread_id,
        status: tblThreads.status,
        config: tblThreads.config,
        metadata: tblThreads.metadata,
        created_at: tblThreads.created_at,
        updated_at: tblThreads.updated_at,
      })
      .from(tblThreads)
      .where(
        whereParts.length
          ? whereParts.reduce(
              (acc, cur) => (acc ? sql`${acc} AND ${cur}` : cur),
              undefined as any
            )
          : undefined
      )
      .orderBy(sql`created_at DESC`)
      .limit(limit)
      .offset(offset);

    return rows.map((row) => ({
      thread_id: row.thread_id,
      status: row.status as string,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    })) as Thread[];
  }

  async delete(threadId: string): Promise<void> {
    await this.db.delete(tblThreads).where(eq(tblThreads.thread_id, threadId));
  }
}

// PostgreSQL Assistants 实现
export class PostgresAssistants implements AssistantsRepo {
  constructor(
    private readonly pool: Pool,
    private readonly db: NodePgDatabase
  ) {}

  async get(assistantId: string): Promise<Assistant | null> {
    const rows = await this.db
      .select({
        id: tblAssistants.id,
        graph_id: tblAssistants.graph_id,
        name: tblAssistants.name,
        description: tblAssistants.description,
        config: tblAssistants.config,
        metadata: tblAssistants.metadata,
        created_at: tblAssistants.created_at,
        updated_at: tblAssistants.updated_at,
      })
      .from(tblAssistants)
      .where(eq(tblAssistants.id, assistantId))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      graph_id: row.graph_id as string,
      name: row.name as string,
      description: row.description as string | null,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as Assistant;
  }

  async put(
    assistant: Omit<Assistant, "created_at" | "updated_at">
  ): Promise<Assistant> {
    const rows = await this.db
      .insert(tblAssistants)
      .values({
        id: assistant.id,
        graph_id: assistant.graph_id,
        name: assistant.name,
        description: assistant.description ?? null,
        config: assistant.config as any,
        metadata: assistant.metadata as any,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: tblAssistants.id,
        set: {
          graph_id: assistant.graph_id,
          name: assistant.name,
          description: assistant.description ?? null,
          config: assistant.config as any,
          metadata: assistant.metadata as any,
          updated_at: new Date(),
        },
      })
      .returning({
        id: tblAssistants.id,
        graph_id: tblAssistants.graph_id,
        name: tblAssistants.name,
        description: tblAssistants.description,
        config: tblAssistants.config,
        metadata: tblAssistants.metadata,
        created_at: tblAssistants.created_at,
        updated_at: tblAssistants.updated_at,
      });

    const row = rows[0];
    return {
      id: row.id,
      graph_id: row.graph_id as string,
      name: row.name as string,
      description: row.description as string | null,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    } as Assistant;
  }

  async search(
    options: {
      graphId?: string;
      metadata?: Record<string, any>;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Assistant[]> {
    const { graphId, metadata, limit = 50, offset = 0 } = options;
    const whereParts = [] as any[];
    if (graphId) whereParts.push(eq(tblAssistants.graph_id, graphId));
    if (metadata)
      whereParts.push(
        sql`${tblAssistants.metadata} @> ${JSON.stringify(metadata)}::jsonb`
      );

    const rows = await this.db
      .select({
        id: tblAssistants.id,
        graph_id: tblAssistants.graph_id,
        name: tblAssistants.name,
        description: tblAssistants.description,
        config: tblAssistants.config,
        metadata: tblAssistants.metadata,
        created_at: tblAssistants.created_at,
        updated_at: tblAssistants.updated_at,
      })
      .from(tblAssistants)
      .where(
        whereParts.length
          ? whereParts.reduce(
              (acc, cur) => (acc ? sql`${acc} AND ${cur}` : cur),
              undefined as any
            )
          : undefined
      )
      .orderBy(sql`created_at DESC`)
      .limit(limit)
      .offset(offset);

    return rows.map((row) => ({
      id: row.id,
      graph_id: row.graph_id as string,
      name: row.name as string,
      description: row.description as string | null,
      config: row.config as any,
      metadata: row.metadata as any,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    })) as Assistant[];
  }

  async delete(assistantId: string): Promise<void> {
    await this.db
      .delete(tblAssistants)
      .where(eq(tblAssistants.id, assistantId));
  }
}
