// Worker 运行时类型定义模块
// 说明：将原 main.mts 中的运行时相关类型抽取为独立文件，便于跨模块复用

import type { Pool } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "winston";

// 宽松类型以兼容不同版本的 LangGraph 泛型签名
export type GraphInstance = any;

// Worker 配置
export interface WorkerConfig {
  port: number;
  host: string;
  workerId: string;
  serverUrl?: string;
  maxConcurrency: number;
  heartbeatInterval: number;
  capabilities: {
    graphs: string[];
    version: string;
  };
}

// 运行上下文：保存执行期状态（SSE 连接、事件缓冲、步索引等）
export interface RunContext {
  runId: string;
  threadId: string;
  graphId: string;
  graph: GraphInstance;
  abortController: AbortController;
  status: "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  events: Array<{ event: string; data: any; timestamp: number }>; // 简单内存缓冲
  sseControllers: Set<ReadableStreamDefaultController>;
  stepIndex: number;
}

// 依赖注入：供 runtime 模块访问数据库与日志
export interface RuntimeDeps {
  pool?: Pool;
  db?: NodePgDatabase;
  logger: Logger;
}