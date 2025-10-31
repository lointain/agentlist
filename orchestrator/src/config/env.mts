// 环境变量加载与校验模块
// 目标：优先使用系统环境变量；若缺失关键项，则回退读取仓库根目录的 .env
// 使用 zod 提供类型与默认值校验，减少在各处重复逻辑

import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

// 环境变量 schema（保留与原 server.mts 一致的字段与默认值）
export const EnvSchema = z.object({
  PORT: z.string().default("8000"),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  WORKER_JS_URL: z.string().optional(),
  WORKER_PY_URL: z.string().optional(),
  ENABLE_RATE_LIMIT: z.string().default("true"),
  ENABLE_AUTH: z.string().default("false"),
  MAX_CONNECTIONS: z.string().default("10"),
  HEALTH_CHECK_INTERVAL: z.string().default("10000"),
});

// 判断是否缺失关键环境变量（数据库与 Redis 必不可少）
function missingCriticalEnv(env: NodeJS.ProcessEnv): boolean {
  return !env.DATABASE_URL || !env.REDIS_URL;
}

// 加载并返回校验后的环境变量对象
// 逻辑：
// 1) 直接解析系统环境变量（process.env）
// 2) 如果缺失关键项，则尝试读取仓库根目录的 .env（相对 orchestrator 目录的上一级）
// 3) 返回通过 zod 校验后的对象（包含默认值）
export function getEnv(): z.infer<typeof EnvSchema> {
  // 第一次尝试：系统环境变量
  let parsed = EnvSchema.safeParse(process.env);
  if (parsed.success && !missingCriticalEnv(process.env)) {
    return parsed.data;
  }

  // 回退：读取上一级目录的 .env（即仓库根目录 e:\workspace25\_ai\agentlist\.env）
  try {
    const repoRootEnv = path.resolve(process.cwd(), "..", ".env");
    if (fs.existsSync(repoRootEnv)) {
      dotenv.config({ path: repoRootEnv });
    } else {
      // 如果没有发现该文件，则仍然尝试默认 .env（保持兼容）
      dotenv.config();
    }
  } catch {
    // 静默回退：避免开发环境无文件时抛出异常
    dotenv.config();
  }

  // 第二次解析（可能已填充缺失项）
  const finalParsed = EnvSchema.parse(process.env);
  return finalParsed;
}

// 辅助：从已解析的环境对象构造服务器配置（在 server.mts 中复用）
export function buildServerConfigFromEnv(env: z.infer<typeof EnvSchema>) {
  return {
    port: Number(env.PORT),
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    workers: { js: env.WORKER_JS_URL, python: env.WORKER_PY_URL },
    enableRateLimit: env.ENABLE_RATE_LIMIT === "true",
    enableAuth: env.ENABLE_AUTH === "true",
    maxConnections: Number(env.MAX_CONNECTIONS),
    healthCheckInterval: Number(env.HEALTH_CHECK_INTERVAL),
  };
}
