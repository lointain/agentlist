// Redis Streams 适配器 - 用于事件流和跨实例通信
// 基于 13-多用户高并发与持久化优化报告.md 的设计

import Redis from 'ioredis';

export interface RedisStreamsConfig {
  url: string;
  keyPrefix?: string;
  maxRetries?: number;
  retryDelayOnFailover?: number;
}

export interface StreamEvent {
  id: string;
  runId: string;
  event: string;
  data: any;
  timestamp: number;
}

export interface StreamConsumerOptions {
  groupName: string;
  consumerName: string;
  batchSize?: number;
  blockTime?: number;
}

// Redis Streams 管理器 - 替代内存 StreamManagerImpl
export class RedisStreamManager {
  private redis: Redis;
  private keyPrefix: string;

  constructor(config: RedisStreamsConfig) {
    this.redis = new Redis(config.url, {
      maxRetriesPerRequest: config.maxRetries ?? 3,
      retryDelayOnFailover: config.retryDelayOnFailover ?? 100,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    this.keyPrefix = config.keyPrefix ?? 'agentlist';
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  // 发布事件到流 - 替代 StreamManagerImpl.publish
  async publish(runId: string, event: string, data: any): Promise<string> {
    const streamKey = this.getStreamKey(runId);
    const eventData = {
      event,
      data: JSON.stringify(data),
      timestamp: Date.now().toString(),
    };

    // 使用 XADD 添加事件到流，自动生成 ID
    const eventId = await this.redis.xadd(
      streamKey,
      '*', // 自动生成时间戳 ID
      'event', eventData.event,
      'data', eventData.data,
      'timestamp', eventData.timestamp
    );

    // 设置流的过期时间（24小时），避免内存泄漏
    await this.redis.expire(streamKey, 24 * 60 * 60);

    return eventId;
  }

  // 消费事件流 - 替代 StreamManagerImpl.join
  async *consume(
    runId: string, 
    options: {
      startId?: string;
      batchSize?: number;
      blockTime?: number;
    } = {}
  ): AsyncGenerator<StreamEvent> {
    const streamKey = this.getStreamKey(runId);
    const startId = options.startId ?? '0'; // 从头开始或指定位置
    const batchSize = options.batchSize ?? 100;
    const blockTime = options.blockTime ?? 1000; // 1秒阻塞

    let lastId = startId;

    while (true) {
      try {
        // 使用 XREAD 读取流事件
        const result = await this.redis.xread(
          'COUNT', batchSize,
          'BLOCK', blockTime,
          'STREAMS', streamKey, lastId
        );

        if (!result || result.length === 0) {
          continue; // 超时或无新事件，继续等待
        }

        const [, events] = result[0];
        
        for (const [eventId, fields] of events) {
          const eventData: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            eventData[fields[i]] = fields[i + 1];
          }

          yield {
            id: eventId,
            runId,
            event: eventData.event,
            data: JSON.parse(eventData.data),
            timestamp: parseInt(eventData.timestamp, 10),
          };

          lastId = eventId; // 更新最后处理的事件 ID
        }
      } catch (error) {
        console.error(`Error consuming stream for run ${runId}:`, error);
        // 短暂等待后重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // 获取流的历史事件 - 用于断连重连
  async getHistory(
    runId: string, 
    options: {
      startId?: string;
      endId?: string;
      count?: number;
    } = {}
  ): Promise<StreamEvent[]> {
    const streamKey = this.getStreamKey(runId);
    const startId = options.startId ?? '-'; // 从最早开始
    const endId = options.endId ?? '+';     // 到最新结束
    const count = options.count ?? 1000;

    const result = await this.redis.xrange(streamKey, startId, endId, 'COUNT', count);
    
    return result.map(([eventId, fields]) => {
      const eventData: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        eventData[fields[i]] = fields[i + 1];
      }

      return {
        id: eventId,
        runId,
        event: eventData.event,
        data: JSON.parse(eventData.data),
        timestamp: parseInt(eventData.timestamp, 10),
      };
    });
  }

  // 创建消费者组 - 用于多实例负载均衡
  async createConsumerGroup(
    runId: string, 
    groupName: string, 
    startId: string = '$'
  ): Promise<void> {
    const streamKey = this.getStreamKey(runId);
    
    try {
      await this.redis.xgroup('CREATE', streamKey, groupName, startId, 'MKSTREAM');
    } catch (error: any) {
      // 忽略 "BUSYGROUP Consumer Group name already exists" 错误
      if (!error.message.includes('BUSYGROUP')) {
        throw error;
      }
    }
  }

  // 使用消费者组消费事件 - 支持多实例水平扩展
  async *consumeWithGroup(
    runId: string,
    options: StreamConsumerOptions
  ): AsyncGenerator<StreamEvent> {
    const streamKey = this.getStreamKey(runId);
    const { groupName, consumerName, batchSize = 10, blockTime = 1000 } = options;

    // 确保消费者组存在
    await this.createConsumerGroup(runId, groupName);

    while (true) {
      try {
        // 使用 XREADGROUP 读取分组事件
        const result = await this.redis.xreadgroup(
          'GROUP', groupName, consumerName,
          'COUNT', batchSize,
          'BLOCK', blockTime,
          'STREAMS', streamKey, '>'
        );

        if (!result || result.length === 0) {
          continue;
        }

        const [, events] = result[0];
        
        for (const [eventId, fields] of events) {
          const eventData: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            eventData[fields[i]] = fields[i + 1];
          }

          const streamEvent: StreamEvent = {
            id: eventId,
            runId,
            event: eventData.event,
            data: JSON.parse(eventData.data),
            timestamp: parseInt(eventData.timestamp, 10),
          };

          yield streamEvent;

          // 确认消息已处理
          await this.redis.xack(streamKey, groupName, eventId);
        }
      } catch (error) {
        console.error(`Error consuming stream with group for run ${runId}:`, error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // 检查流是否存在
  async streamExists(runId: string): Promise<boolean> {
    const streamKey = this.getStreamKey(runId);
    const result = await this.redis.exists(streamKey);
    return result === 1;
  }

  // 获取流信息
  async getStreamInfo(runId: string): Promise<any> {
    const streamKey = this.getStreamKey(runId);
    return await this.redis.xinfo('STREAM', streamKey);
  }

  // 删除流
  async deleteStream(runId: string): Promise<void> {
    const streamKey = this.getStreamKey(runId);
    await this.redis.del(streamKey);
  }

  // 清理过期流 - 定期清理任务
  async cleanupExpiredStreams(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
    const pattern = `${this.keyPrefix}:stream:*`;
    const keys = await this.redis.keys(pattern);
    let deletedCount = 0;

    for (const key of keys) {
      try {
        const info = await this.redis.xinfo('STREAM', key);
        const lastEntryId = info[info.indexOf('last-entry') + 1]?.[0];
        
        if (lastEntryId) {
          const timestamp = parseInt(lastEntryId.split('-')[0], 10);
          const age = Date.now() - timestamp;
          
          if (age > maxAge) {
            await this.redis.del(key);
            deletedCount++;
          }
        }
      } catch (error) {
        // 流可能已被删除，忽略错误
        console.warn(`Failed to check stream ${key}:`, error);
      }
    }

    return deletedCount;
  }

  private getStreamKey(runId: string): string {
    return `${this.keyPrefix}:stream:${runId}`;
  }
}

// 跨实例锁管理器 - 替代内存锁
export class RedisLockManager {
  private redis: Redis;
  private keyPrefix: string;

  constructor(config: RedisStreamsConfig) {
    this.redis = new Redis(config.url);
    this.keyPrefix = config.keyPrefix ?? 'agentlist';
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  // 获取分布式锁
  async acquireLock(
    runId: string, 
    ttl: number = 30000, // 30秒 TTL
    retryDelay: number = 100
  ): Promise<string | null> {
    const lockKey = this.getLockKey(runId);
    const lockValue = `${Date.now()}-${Math.random()}`;

    // 使用 SET NX EX 原子操作获取锁
    const result = await this.redis.set(lockKey, lockValue, 'PX', ttl, 'NX');
    
    if (result === 'OK') {
      return lockValue;
    }
    
    return null;
  }

  // 释放分布式锁
  async releaseLock(runId: string, lockValue: string): Promise<boolean> {
    const lockKey = this.getLockKey(runId);
    
    // 使用 Lua 脚本确保原子性释放
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    
    const result = await this.redis.eval(script, 1, lockKey, lockValue);
    return result === 1;
  }

  // 检查锁是否存在
  async isLocked(runId: string): Promise<boolean> {
    const lockKey = this.getLockKey(runId);
    const result = await this.redis.exists(lockKey);
    return result === 1;
  }

  // 续期锁
  async renewLock(runId: string, lockValue: string, ttl: number = 30000): Promise<boolean> {
    const lockKey = this.getLockKey(runId);
    
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    
    const result = await this.redis.eval(script, 1, lockKey, lockValue, ttl);
    return result === 1;
  }

  private getLockKey(runId: string): string {
    return `${this.keyPrefix}:lock:${runId}`;
  }
}

// 跨实例取消信号管理器
export class RedisCancellationManager {
  private redis: Redis;
  private keyPrefix: string;

  constructor(config: RedisStreamsConfig) {
    this.redis = new Redis(config.url);
    this.keyPrefix = config.keyPrefix ?? 'agentlist';
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  // 发送取消信号
  async sendCancelSignal(runId: string, action: string = 'interrupt'): Promise<void> {
    const cancelKey = this.getCancelKey(runId);
    await this.redis.setex(cancelKey, 300, action); // 5分钟过期
    
    // 同时发布到 Pub/Sub 频道，用于实时通知
    const channel = this.getCancelChannel(runId);
    await this.redis.publish(channel, action);
  }

  // 检查取消信号
  async checkCancelSignal(runId: string): Promise<string | null> {
    const cancelKey = this.getCancelKey(runId);
    return await this.redis.get(cancelKey);
  }

  // 清除取消信号
  async clearCancelSignal(runId: string): Promise<void> {
    const cancelKey = this.getCancelKey(runId);
    await this.redis.del(cancelKey);
  }

  // 订阅取消信号 - 用于实时响应
  async subscribeCancelSignal(
    runId: string, 
    callback: (action: string) => void
  ): Promise<() => void> {
    const subscriber = new Redis(this.redis.options);
    const channel = this.getCancelChannel(runId);
    
    await subscriber.subscribe(channel);
    
    subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) {
        callback(message);
      }
    });

    // 返回取消订阅函数
    return async () => {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    };
  }

  private getCancelKey(runId: string): string {
    return `${this.keyPrefix}:cancel:${runId}`;
  }

  private getCancelChannel(runId: string): string {
    return `${this.keyPrefix}:cancel-channel:${runId}`;
  }
}