// Worker 侧图加载与缓存
// 目标：参考 server/src/graph/load.mts，将图的注册/获取逻辑迁移到 Worker

import { HTTPException } from "hono/http-exception";
import { resolveGraph } from "./load.utils.js";
// 宽松类型以兼容不同版本的 LangGraph 泛型签名
type GraphInstance = any;

// 全局缓存：已编译图或工厂函数
const GRAPHS: Record<
  string,
  GraphInstance | ((config: any) => Promise<GraphInstance> | GraphInstance)
> = {};
const GRAPH_SPEC: Record<
  string,
  { sourceFile: string; exportSymbol?: string }
> = {};

// 从环境变量读取默认运行配置（与 orchestrator 保持一致）
const ENV_CONFIG: Record<string, any> | undefined = (() => {
  try {
    return process.env.LANGGRAPH_CONFIG
      ? JSON.parse(process.env.LANGGRAPH_CONFIG)
      : undefined;
  } catch {
    return undefined;
  }
})();

export async function registerFromEnv(
  specs: Record<string, string>,
  options: { cwd: string }
): Promise<Array<GraphInstance | ((config: any) => Promise<GraphInstance>)>> {
  const out: Array<GraphInstance | ((config: any) => Promise<GraphInstance>)> =
    [];
  for (const [graphId, rawSpec] of Object.entries(specs)) {
    const { resolved, sourceFile, exportSymbol } = await resolveGraph(
      rawSpec,
      options
    );
    GRAPHS[graphId] = resolved as any;
    GRAPH_SPEC[graphId] = { sourceFile, exportSymbol };
    out.push(resolved as any);
  }
  return out;
}

export async function getGraph(
  graphId: string,
  config?: any,
  options?: { forceReload?: boolean; cwd?: string }
): Promise<GraphInstance> {
  if (!options?.forceReload && graphId in GRAPHS) {
    const entry = GRAPHS[graphId];
    if (typeof entry === "function") {
      const compiled = await entry(config ?? { configurable: {} });
      return compiled as GraphInstance;
    }
    return entry as GraphInstance;
  }

  // 动态加载：优先从已注册的 spec，若不存在则尝试默认路径 ./graphs/<graphId>.mjs
  const spec = GRAPH_SPEC[graphId];
  if (spec) {
    const entry = GRAPHS[graphId];
    if (typeof entry === "function") {
      const compiled = await (entry as any)(config ?? { configurable: {} });
      return compiled as GraphInstance;
    }
    return entry as GraphInstance;
  }

  try {
    const defaultSpec = `./graphs/${graphId}.mjs`;
    const { resolved } = await resolveGraph(defaultSpec, {
      cwd: options?.cwd ?? process.cwd(),
    });
    GRAPHS[graphId] = resolved as any;
    if (typeof resolved === "function") {
      const compiled = await (resolved as any)(config ?? { configurable: {} });
      return compiled as GraphInstance;
    }
    return resolved as GraphInstance;
  } catch (error) {
    throw new HTTPException(404, {
      message: `Graph \"${graphId}\" 加载失败：${(error as Error).message}`,
    });
  }
}

export function assertGraphExists(graphId: string) {
  if (!GRAPHS[graphId])
    throw new HTTPException(404, {
      message: `Graph \"${graphId}\" 未注册或不可用`,
    });
}

export function getGraphKeys(): string[] {
  return Object.keys(GRAPHS);
}
