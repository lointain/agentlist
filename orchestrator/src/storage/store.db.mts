// 基于 Drizzle ORM 的 Store 适配器（统一改造）
// - key 采用扁平字符串：namespace.join('.') + '.' + key
// - value 使用 JSONB 存储
// - 完全使用 Drizzle 进行 CRUD

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, eq, sql } from "drizzle-orm";
import { store as tblStore } from "./schema.mts";
import type { Item } from "@langchain/langgraph";
import { getEnv } from "../config/env.mts";

// 帮助函数：将命名空间与 key 拼接为唯一键
const nsKey = (namespace: string[] | undefined, key: string) => {
  const ns = (namespace ?? []).filter(Boolean);
  return ns.length ? `${ns.join(".")}.${key}` : key;
};

// 帮助函数：从扁平 key 拆回命名空间与 key
const splitNsKey = (flatKey: string): { namespace: string[]; key: string } => {
  const parts = flatKey.split(".");
  if (parts.length <= 1) return { namespace: [], key: flatKey };
  const k = parts.pop()!;
  return { namespace: parts, key: k };
};

export class DrizzleStoreAdapter {
  private pool: Pool;
  private db: ReturnType<typeof drizzle>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.db = drizzle(this.pool);
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

    const rows = await this.db
      .select({ key: tblStore.key })
      .from(tblStore)
      .orderBy(desc(tblStore.updated_at))
      .limit(limit)
      .offset(offset);

    const set = new Set<string>();
    for (const row of rows) {
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

    const whereClauses = [] as any[];
    if (namespacePrefix && namespacePrefix.length) {
      whereClauses.push(
        sql`${tblStore.key} LIKE ${namespacePrefix.join(".") + ".%"}`
      );
    }
    if (query && query.trim().length) {
      whereClauses.push(
        sql`CAST(${tblStore.value} AS TEXT) ILIKE ${"%" + query + "%"}`
      );
    }

    const rows = await this.db
      .select({
        key: tblStore.key,
        value: tblStore.value,
        updated_at: tblStore.updated_at,
      })
      .from(tblStore)
      .where(
        whereClauses.length === 0
          ? undefined
          : whereClauses.reduce(
              (acc, clause) => (acc ? sql`${acc} AND ${clause}` : clause),
              undefined as any
            )
      )
      .orderBy(desc(tblStore.updated_at))
      .limit(limit)
      .offset(offset);

    return rows.map((row) => {
      const { namespace, key } = splitNsKey(row.key as string);
      return {
        namespace,
        key,
        value: row.value,
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
    await this.db
      .insert(tblStore)
      .values({ key: flatKey, value: value as any, updated_at: new Date() })
      .onConflictDoUpdate({
        target: tblStore.key,
        set: { value: value as any, updated_at: new Date() },
      });
  }

  // 删除
  async delete(namespace: string[] | undefined, key: string): Promise<void> {
    const flatKey = nsKey(namespace, key);
    await this.db.delete(tblStore).where(eq(tblStore.key, flatKey));
  }

  // 获取单条
  async get(
    namespace: string[] | undefined,
    key: string
  ): Promise<Item | null> {
    const flatKey = nsKey(namespace, key);
    const rows = await this.db
      .select({
        key: tblStore.key,
        value: tblStore.value,
        updated_at: tblStore.updated_at,
      })
      .from(tblStore)
      .where(eq(tblStore.key, flatKey))
      .limit(1);
    if (!rows.length) return null;
    const row = rows[0];
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
// 优先使用系统环境；若缺失则回退到仓库根 .env（由 getEnv() 处理）
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  try {
    const env = getEnv();
    DATABASE_URL = env.DATABASE_URL;
  } catch {
    // 保持静默，避免在模块导入阶段抛错
  }
}

export const storeDb = DATABASE_URL
  ? new DrizzleStoreAdapter(DATABASE_URL)
  : undefined;
