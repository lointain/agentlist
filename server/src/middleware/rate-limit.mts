// 限流中间件 - 多租户限流和优先级控制
// 基于令牌桶算法实现

import type { MiddlewareHandler } from "hono";
import Redis from "ioredis";

export interface RateLimitConfig {
  // 基础配置
  capacity: number; // 桶容量
  refillRate: number; // 每秒补充令牌数
  windowMs: number; // 时间窗口（毫秒）

  // 多租户配置
  keyGenerator: (c: any) => string; // 生成限流键的函数

  // Redis 配置（可选，用于跨实例共享）
  redis?: Redis;

  // 响应配置
  message?: string;
  statusCode?: number;
  headers?: Record<string, string>;

  // 跳过条件
  skip?: (c: any) => boolean;

  // 优先级配置
  priorityLevels?: Record<string, { capacity: number; refillRate: number }>;
}

export interface TokenBucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
}

// 内存令牌桶管理器
export class MemoryTokenBucketManager {
  private buckets = new Map<string, TokenBucket>();

  getBucket(key: string, capacity: number, refillRate: number): TokenBucket {
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: capacity,
        lastRefill: Date.now(),
        capacity,
        refillRate,
      };
      this.buckets.set(key, bucket);
    }

    return bucket;
  }

  consumeToken(key: string, capacity: number, refillRate: number): boolean {
    const bucket = this.getBucket(key, capacity, refillRate);
    const now = Date.now();

    // 计算需要补充的令牌数
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsed * refillRate;

    // 更新令牌数（不超过容量）
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // 尝试消费令牌
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  // 清理过期的桶（定期调用）
  cleanup(maxAge: number = 5 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAge) {
        this.buckets.delete(key);
      }
    }
  }
}

// Redis 令牌桶管理器
export class RedisTokenBucketManager {
  constructor(private readonly redis: Redis) {}

  async consumeToken(
    key: string,
    capacity: number,
    refillRate: number
  ): Promise<boolean> {
    const script = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      
      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(bucket[1]) or capacity
      local last_refill = tonumber(bucket[2]) or now
      
      -- 计算需要补充的令牌
      local elapsed = (now - last_refill) / 1000
      local tokens_to_add = elapsed * refill_rate
      tokens = math.min(capacity, tokens + tokens_to_add)
      
      -- 尝试消费令牌
      if tokens >= 1 then
        tokens = tokens - 1
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 300) -- 5分钟过期
        return 1
      else
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 300)
        return 0
      end
    `;

    const result = await this.redis.eval(
      script,
      1,
      key,
      capacity.toString(),
      refillRate.toString(),
      Date.now().toString()
    );

    return result === 1;
  }
}

// 创建限流中间件
export function createRateLimit(config: RateLimitConfig): MiddlewareHandler {
  const {
    capacity,
    refillRate,
    keyGenerator,
    redis,
    message = "Too Many Requests",
    statusCode = 429,
    headers = {},
    skip,
    priorityLevels = {},
  } = config;

  // 选择令牌桶管理器
  const bucketManager = redis
    ? new RedisTokenBucketManager(redis)
    : new MemoryTokenBucketManager();

  // 如果使用内存管理器，启动清理任务
  if (!redis && bucketManager instanceof MemoryTokenBucketManager) {
    setInterval(() => {
      bucketManager.cleanup();
    }, 60000); // 每分钟清理一次
  }

  return async (c, next) => {
    // 检查是否跳过限流
    if (skip && skip(c)) {
      await next();
      return;
    }

    // 生成限流键
    const key = keyGenerator(c);

    // 获取优先级配置
    const priority = c.get("priority") || "default";
    const priorityConfig = priorityLevels[priority] || { capacity, refillRate };

    // 尝试消费令牌
    const allowed = redis
      ? await (bucketManager as RedisTokenBucketManager).consumeToken(
          key,
          priorityConfig.capacity,
          priorityConfig.refillRate
        )
      : (bucketManager as MemoryTokenBucketManager).consumeToken(
          key,
          priorityConfig.capacity,
          priorityConfig.refillRate
        );

    if (!allowed) {
      // 设置响应头
      Object.entries(headers).forEach(([name, value]) => {
        c.header(name, value);
      });

      // 添加限流信息头
      c.header("X-RateLimit-Limit", priorityConfig.capacity.toString());
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", (Date.now() + 1000).toString());

      return c.text(message, statusCode);
    }

    await next();
  };
}

// 预定义的限流配置

// 基于用户 ID 的限流
export const userRateLimit = (
  capacity: number = 100,
  refillRate: number = 20,
  redis?: Redis
) =>
  createRateLimit({
    capacity,
    refillRate,
    windowMs: 60000,
    keyGenerator: (c) => {
      const userId =
        c.get("userId") || c.req.header("x-user-id") || "anonymous";
      return `rate_limit:user:${userId}`;
    },
    redis,
    priorityLevels: {
      premium: { capacity: capacity * 2, refillRate: refillRate * 2 },
      standard: { capacity, refillRate },
      basic: {
        capacity: Math.floor(capacity / 2),
        refillRate: Math.floor(refillRate / 2),
      },
    },
  });

// 基于租户 ID 的限流
export const tenantRateLimit = (
  capacity: number = 1000,
  refillRate: number = 100,
  redis?: Redis
) =>
  createRateLimit({
    capacity,
    refillRate,
    windowMs: 60000,
    keyGenerator: (c) => {
      const tenantId =
        c.get("tenantId") || c.req.header("x-tenant-id") || "default";
      return `rate_limit:tenant:${tenantId}`;
    },
    redis,
  });

// 基于 IP 的限流
export const ipRateLimit = (
  capacity: number = 200,
  refillRate: number = 50,
  redis?: Redis
) =>
  createRateLimit({
    capacity,
    refillRate,
    windowMs: 60000,
    keyGenerator: (c) => {
      const ip =
        c.req.header("x-forwarded-for") ||
        c.req.header("x-real-ip") ||
        "unknown";
      return `rate_limit:ip:${ip}`;
    },
    redis,
  });

// 基于 API 端点的限流
export const endpointRateLimit = (
  capacity: number = 500,
  refillRate: number = 100,
  redis?: Redis
) =>
  createRateLimit({
    capacity,
    refillRate,
    windowMs: 60000,
    keyGenerator: (c) => {
      const method = c.req.method;
      const path = c.req.path;
      return `rate_limit:endpoint:${method}:${path}`;
    },
    redis,
  });

// 组合限流中间件
export function createMultiLevelRateLimit(redis?: Redis) {
  return [
    // IP 级别限流（最宽松）
    ipRateLimit(1000, 200, redis),

    // 租户级别限流
    tenantRateLimit(500, 100, redis),

    // 用户级别限流（最严格）
    userRateLimit(100, 20, redis),
  ];
}
