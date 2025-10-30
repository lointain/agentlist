// Worker 侧图解析与编译工具
// 目标：参考 orchestrator/src/graph/load.utils.mts，在 Worker 内实现图解析/编译
// 支持 "path[:exportSymbol]" 语法，默认导出为 default

import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
// 宽松类型以兼容不同版本的 LangGraph 泛型签名
type GraphInstance = any;

// 判断对象是否为已编译图（最小判断，避免引入过多内部类型）
function isCompiledGraph(obj: any): obj is GraphInstance {
  return obj && typeof obj === "object" && typeof obj.stream === "function";
}

// 判断对象是否为 Graph（可 compile）
function isGraph(obj: any): boolean {
  return obj && typeof obj === "object" && typeof obj.compile === "function";
}

export async function resolveGraph(
  spec: string,
  options: { cwd: string }
): Promise<{ resolved: GraphInstance | ((config: any) => Promise<GraphInstance> | GraphInstance); sourceFile: string; exportSymbol?: string } & Record<string, any>> {
  // 解析 "path[:exportSymbol]" 形式
  const [userFile, exportSymbol] = spec.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  // 验证文件存在
  await fs.stat(sourceFile);

  // 动态导入模块并获取导出的图或工厂
  const modUrl = pathToFileURL(sourceFile).toString();
  const mod = await import(modUrl);
  const exported = mod[exportSymbol || "default"];

  // 情况1：Graph（需 compile）
  if (isGraph(exported)) {
    const compiled = await exported.compile();
    return { sourceFile, exportSymbol, resolved: compiled };
  }

  // 情况2：工厂函数（按运行配置动态生成已编译图）
  if (typeof exported === "function") {
    const factory = async (config: any) => {
      const result = await exported(config);
      // 某些工厂可能返回 Graph，需要再 compile 一次
      if (isGraph(result)) return await result.compile();
      return result as GraphInstance;
    };
    return { sourceFile, exportSymbol, resolved: factory };
  }

  // 情况3：已编译图对象
  if (isCompiledGraph(exported)) {
    return { sourceFile, exportSymbol, resolved: exported };
  }

  throw new Error(`无法解析图：${spec}，请检查导出是否为 Graph/工厂函数/已编译图`);
}