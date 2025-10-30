// PostgreSQL 存储适配器 - 高并发优化版本
// 基于 13-多用户高并发与持久化优化报告.md 的设计

import { Pool, PoolClient } from 'pg';
import type { 
  RunsRepo, 
  ThreadsRepo, 
  AssistantsRepo,
  Run, 
  Thread, 
  Assistant,
  RunnableConfig, 
  Metadata 
} from '../storage/types.mts';

export interface PostgresConfig {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class PostgresAdapter {
  private pool: Pool;

  constructor(config: PostgresConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections ?? 20,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  get runs(): RunsRepo {
    return new PostgresRuns(this.pool);
  }

  get threads(): ThreadsRepo {
    return new PostgresThreads(this.pool);
  }

  get assistants(): AssistantsRepo {
    return new PostgresAssistants(this.pool);
  }
}

// PostgreSQL Runs 实现 - 支持高并发调度
export class PostgresRuns implements RunsRepo {
  constructor(private readonly pool: Pool) {}

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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 确保线程存在，如果不存在则创建
      if (options.threadId) {
        await client.query(
          `INSERT INTO threads(thread_id, status, metadata, created_at, updated_at)
           VALUES($1, 'idle', $2, NOW(), NOW())
           ON CONFLICT(thread_id) DO NOTHING`,
          [options.threadId, options.metadata ?? {}]
        );
      }

      // 2. 检查是否允许插入（防止重复运行）
      if (options.ifNotExists) {
        const existingRun = await client.query(
          'SELECT run_id FROM runs WHERE run_id = $1',
          [runId]
        );
        if (existingRun.rowCount > 0) {
          await client.query('COMMIT');
          return this.getRunsByThread(options.threadId!, client);
        }
      }

      // 3. 处理多任务策略
      if (options.multitaskStrategy === 'reject' && options.threadId) {
        const runningRuns = await client.query(
          `SELECT run_id FROM runs 
           WHERE thread_id = $1 AND status IN ('pending', 'running')`,
          [options.threadId]
        );
        if (runningRuns.rowCount > 0) {
          throw new Error(`Thread ${options.threadId} already has running tasks`);
        }
      }

      // 4. 插入新的 run（幂等）
      const scheduledAt = options.afterSeconds 
        ? `NOW() + INTERVAL '${options.afterSeconds} seconds'`
        : 'NOW()';

      await client.query(
        `INSERT INTO runs(
          run_id, thread_id, assistant_id, status, kwargs, metadata, 
          scheduled_at, created_at, updated_at
        )
        VALUES($1, $2, $3, $4, $5, $6, ${scheduledAt}, NOW(), NOW())
        ON CONFLICT(run_id) DO UPDATE SET
          status = EXCLUDED.status,
          kwargs = EXCLUDED.kwargs,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()`,
        [
          runId, 
          options.threadId, 
          assistantId, 
          options.status ?? 'pending', 
          JSON.stringify(kwargs), 
          JSON.stringify(options.metadata ?? {})
        ]
      );

      await client.query('COMMIT');
      
      // 返回该线程的在途 run 列表
      return this.getRunsByThread(options.threadId!, client);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // 安全调度：一次性锁定一批待处理 run，避免多工作者抢占
  async *next(): AsyncGenerator<{ 
    run: Run; 
    attempt: number; 
    signal: AbortSignal 
  }> {
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        
        // 使用 SKIP LOCKED 避免锁等待，提升并发调度
        const res = await client.query(
          `SELECT r.*, a.graph_id, a.config as assistant_config
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
           LIMIT 10`
        );

        if (res.rowCount === 0) {
          await client.query('COMMIT');
          client.release();
          // 空闲等待一段时间再尝试
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        for (const row of res.rows) {
          const runId = row.run_id as string;
          
          // 将状态置为 running，增加 attempt
          await client.query(
            `UPDATE runs SET 
               status = 'running', 
               attempt = attempt + 1,
               started_at = NOW(),
               updated_at = NOW() 
             WHERE run_id = $1`,
            [runId]
          );

          await client.query('COMMIT');
          
          // 创建取消信号（实际应用中可用 Redis Pub/Sub 等跨进程机制）
          const controller = new AbortController();
          
          yield { 
            run: {
              run_id: runId,
              thread_id: row.thread_id,
              assistant_id: row.assistant_id,
              status: 'running',
              kwargs: row.kwargs,
              metadata: row.metadata,
              graph_id: row.graph_id,
              config: row.assistant_config,
              attempt: row.attempt + 1,
              created_at: row.created_at,
              updated_at: new Date()
            } as Run, 
            attempt: row.attempt + 1, 
            signal: controller.signal 
          };
        }
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async get(runId: string): Promise<Run | null> {
    const res = await this.pool.query(
      `SELECT r.*, a.graph_id, a.config as assistant_config
       FROM runs r
       JOIN assistants a ON r.assistant_id = a.id
       WHERE r.run_id = $1`,
      [runId]
    );
    
    if (res.rowCount === 0) return null;
    
    const row = res.rows[0];
    return {
      run_id: row.run_id,
      thread_id: row.thread_id,
      assistant_id: row.assistant_id,
      status: row.status,
      kwargs: row.kwargs,
      metadata: row.metadata,
      graph_id: row.graph_id,
      config: row.assistant_config,
      attempt: row.attempt,
      created_at: row.created_at,
      updated_at: row.updated_at
    } as Run;
  }

  async updateStatus(
    runId: string, 
    status: string, 
    metadata?: Metadata
  ): Promise<void> {
    const updateFields = ['status = $2', 'updated_at = NOW()'];
    const values = [runId, status];
    
    if (metadata) {
      updateFields.push('metadata = $3');
      values.push(JSON.stringify(metadata));
    }
    
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updateFields.push('completed_at = NOW()');
    }

    await this.pool.query(
      `UPDATE runs SET ${updateFields.join(', ')} WHERE run_id = $1`,
      values
    );
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
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (options.threadId) {
      conditions.push(`r.thread_id = $${paramIndex++}`);
      values.push(options.threadId);
    }

    if (options.assistantId) {
      conditions.push(`r.assistant_id = $${paramIndex++}`);
      values.push(options.assistantId);
    }

    if (options.status && options.status.length > 0) {
      conditions.push(`r.status = ANY($${paramIndex++})`);
      values.push(options.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT $${paramIndex++}` : '';
    const offsetClause = options.offset ? `OFFSET $${paramIndex++}` : '';

    if (options.limit) values.push(options.limit);
    if (options.offset) values.push(options.offset);

    const res = await this.pool.query(
      `SELECT r.*, a.graph_id, a.config as assistant_config
       FROM runs r
       JOIN assistants a ON r.assistant_id = a.id
       ${whereClause}
       ORDER BY r.created_at DESC
       ${limitClause} ${offsetClause}`,
      values
    );

    return res.rows.map(row => ({
      run_id: row.run_id,
      thread_id: row.thread_id,
      assistant_id: row.assistant_id,
      status: row.status,
      kwargs: row.kwargs,
      metadata: row.metadata,
      graph_id: row.graph_id,
      config: row.assistant_config,
      attempt: row.attempt,
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as Run[];
  }

  private async getRunsByThread(threadId: string, client?: PoolClient): Promise<Run[]> {
    const db = client || this.pool;
    const res = await db.query(
      `SELECT r.*, a.graph_id, a.config as assistant_config
       FROM runs r
       JOIN assistants a ON r.assistant_id = a.id
       WHERE r.thread_id = $1 AND r.status IN ('pending','running') 
       ORDER BY r.created_at ASC`,
      [threadId]
    );
    
    return res.rows.map(row => ({
      run_id: row.run_id,
      thread_id: row.thread_id,
      assistant_id: row.assistant_id,
      status: row.status,
      kwargs: row.kwargs,
      metadata: row.metadata,
      graph_id: row.graph_id,
      config: row.assistant_config,
      attempt: row.attempt,
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as Run[];
  }
}

// PostgreSQL Threads 实现
export class PostgresThreads implements ThreadsRepo {
  constructor(private readonly pool: Pool) {}

  async get(threadId: string): Promise<Thread | null> {
    const res = await this.pool.query(
      'SELECT * FROM threads WHERE thread_id = $1',
      [threadId]
    );
    
    if (res.rowCount === 0) return null;
    
    const row = res.rows[0];
    return {
      thread_id: row.thread_id,
      status: row.status,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    } as Thread;
  }

  async put(
    threadId: string,
    config: RunnableConfig,
    metadata?: Metadata
  ): Promise<Thread> {
    const res = await this.pool.query(
      `INSERT INTO threads(thread_id, config, metadata, created_at, updated_at)
       VALUES($1, $2, $3, NOW(), NOW())
       ON CONFLICT(thread_id) DO UPDATE SET
         config = EXCLUDED.config,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [threadId, JSON.stringify(config), JSON.stringify(metadata ?? {})]
    );

    const row = res.rows[0];
    return {
      thread_id: row.thread_id,
      status: row.status,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    } as Thread;
  }

  async updateStatus(threadId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE threads SET status = $2, updated_at = NOW() WHERE thread_id = $1',
      [threadId, status]
    );
  }

  async search(
    options: {
      status?: string;
      metadata?: Record<string, any>;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<Thread[]> {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(options.status);
    }

    if (options.metadata) {
      conditions.push(`metadata @> $${paramIndex++}`);
      values.push(JSON.stringify(options.metadata));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT $${paramIndex++}` : '';
    const offsetClause = options.offset ? `OFFSET $${paramIndex++}` : '';

    if (options.limit) values.push(options.limit);
    if (options.offset) values.push(options.offset);

    const res = await this.pool.query(
      `SELECT * FROM threads ${whereClause} ORDER BY created_at DESC ${limitClause} ${offsetClause}`,
      values
    );

    return res.rows.map(row => ({
      thread_id: row.thread_id,
      status: row.status,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as Thread[];
  }

  async delete(threadId: string): Promise<void> {
    await this.pool.query('DELETE FROM threads WHERE thread_id = $1', [threadId]);
  }
}

// PostgreSQL Assistants 实现
export class PostgresAssistants implements AssistantsRepo {
  constructor(private readonly pool: Pool) {}

  async get(assistantId: string): Promise<Assistant | null> {
    const res = await this.pool.query(
      'SELECT * FROM assistants WHERE id = $1',
      [assistantId]
    );
    
    if (res.rowCount === 0) return null;
    
    const row = res.rows[0];
    return {
      id: row.id,
      graph_id: row.graph_id,
      name: row.name,
      description: row.description,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    } as Assistant;
  }

  async put(assistant: Omit<Assistant, 'created_at' | 'updated_at'>): Promise<Assistant> {
    const res = await this.pool.query(
      `INSERT INTO assistants(id, graph_id, name, description, config, metadata, created_at, updated_at)
       VALUES($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT(id) DO UPDATE SET
         graph_id = EXCLUDED.graph_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         config = EXCLUDED.config,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING *`,
      [
        assistant.id,
        assistant.graph_id,
        assistant.name,
        assistant.description,
        JSON.stringify(assistant.config),
        JSON.stringify(assistant.metadata)
      ]
    );

    const row = res.rows[0];
    return {
      id: row.id,
      graph_id: row.graph_id,
      name: row.name,
      description: row.description,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
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
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (options.graphId) {
      conditions.push(`graph_id = $${paramIndex++}`);
      values.push(options.graphId);
    }

    if (options.metadata) {
      conditions.push(`metadata @> $${paramIndex++}`);
      values.push(JSON.stringify(options.metadata));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = options.limit ? `LIMIT $${paramIndex++}` : '';
    const offsetClause = options.offset ? `OFFSET $${paramIndex++}` : '';

    if (options.limit) values.push(options.limit);
    if (options.offset) values.push(options.offset);

    const res = await this.pool.query(
      `SELECT * FROM assistants ${whereClause} ORDER BY created_at DESC ${limitClause} ${offsetClause}`,
      values
    );

    return res.rows.map(row => ({
      id: row.id,
      graph_id: row.graph_id,
      name: row.name,
      description: row.description,
      config: row.config,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as Assistant[];
  }

  async delete(assistantId: string): Promise<void> {
    await this.pool.query('DELETE FROM assistants WHERE id = $1', [assistantId]);
  }
}