// 基于 Postgres 的 Store 适配器
// 说明：替换原来的文件系统 InMemoryStore，改为使用数据库表 `store`
// - key 采用扁平字符串，约定以命名空间拼接：namespace.join('.') + '.' + key
// - value 使用 JSONB 存储
// 注意：该实现为最小可用版本，满足现有 API（list/search/get/put/delete）需求

import { Pool } from "pg";
import type { Item } from "@langchain/langgraph";

// 帮助函数：将命名空间与 key 拼接为唯一键
const nsKey = (namespace: string[] | undefined, key: string) => {
  const ns = (namespace ?? []).filter(Boolean);
  return ns.length ? `${ns.join(".")}.${key}` : key;
};

// 帮助函数：从扁平 key 拆回命名空间与 key
const splitNsKey = (flatKey: string): { namespace: string[]; key: string } => {
  const parts = flatKey.split(".");
  if (parts.length <= 1) return { namespace: [], key: flatKey };
  const key = parts.pop()!;
  return { namespace: parts, key };
};

export class PostgresStoreAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  // 列出命名空间：按前缀/后缀与最大深度进行过滤，返回所有存在的命名空间路径
  async listNamespaces(options: {
    limit?: number;
    offset?: number;
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
  }): Promise<string[][]> {
    const { limit = 100, offset = 0, prefix, suffix, maxDepth } = options;

    // 简化实现：读出所有 key，然后在内存中按规则聚合命名空间
    const res = await this.pool.query(
      `SELECT key FROM store ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const set = new Set<string>();
    for (const row of res.rows) {
      const { namespace } = splitNsKey(row.key as string);
      if (
        prefix &&
        prefix.length &&
        !namespace.slice(0, prefix.length).every((v, i) => v === prefix[i])
      ) {
        continue;
      }
      if (
        suffix &&
        suffix.length &&
        !namespace.slice(-suffix.length).every((v, i) => v === suffix[i])
      ) {
        continue;
      }
      const trimmed = maxDepth ? namespace.slice(0, maxDepth) : namespace;
      set.add(trimmed.join("."));
    }

    return Array.from(set).map((s) => (s ? s.split(".") : []));
  }

  // 搜索条目：按命名空间前缀与可选文本查询过滤
  async search(
    namespacePrefix: string[] | undefined,
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string | null;
    }
  ): Promise<Item[]> {
    const { limit = 10, offset = 0, query } = options;

    // 简化：query 采用将 JSON 转文本后 ILIKE 的方式（性能一般，但可用）
    const where: string[] = [];
    const params: any[] = [];

    if (namespacePrefix && namespacePrefix.length) {
      where.push(`key LIKE $${params.length + 1}`);
      params.push(`${namespacePrefix.join(".")}.%`);
    }

    if (query && query.trim().length) {
      where.push(`CAST(value AS TEXT) ILIKE $${params.length + 1}`);
      params.push(`%${query}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const res = await this.pool.query(
      `SELECT key, value, updated_at FROM store ${whereClause} ORDER BY updated_at DESC LIMIT $${
        params.length + 1
      } OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.rows.map((row) => {
      const { namespace, key } = splitNsKey(row.key as string);
      return {
        namespace,
        key,
        value: row.value,
        // 该表当前只有 updated_at，这里将 createdAt 等同于 updated_at 以兼容 API
        createdAt: row.updated_at,
        updatedAt: row.updated_at,
      } as Item;
    });
  }

  // 写入（Upsert）
  async put(
    namespace: string[] | undefined,
    key: string,
    value: unknown
  ): Promise<void> {
    const flatKey = nsKey(namespace, key);
    await this.pool.query(
      `INSERT INTO store (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [flatKey, JSON.stringify(value)]
    );
  }

  // 删除
  async delete(namespace: string[] | undefined, key: string): Promise<void> {
    const flatKey = nsKey(namespace, key);
    await this.pool.query(`DELETE FROM store WHERE key = $1`, [flatKey]);
  }

  // 获取单条
  async get(
    namespace: string[] | undefined,
    key: string
  ): Promise<Item | null> {
    const flatKey = nsKey(namespace, key);
    const res = await this.pool.query(
      `SELECT key, value, updated_at FROM store WHERE key = $1`,
      [flatKey]
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    const { namespace: ns, key: k } = splitNsKey(row.key as string);
    return {
      namespace: ns,
      key: k,
      value: row.value,
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    } as Item;
  }
}

// 便捷导出：从环境变量读取数据库连接，暴露实例
// 注：如需复用连接，可改为由 server.mts 注入连接池，这里保持最小改动
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // 仅日志提示，不抛错，避免开发环境未配置时直接崩溃
  console.warn(
    "[PostgresStoreAdapter] DATABASE_URL 未设置，store API 将不可用"
  );
}

export const storeDb = DATABASE_URL
  ? new PostgresStoreAdapter(DATABASE_URL)
  : undefined;
