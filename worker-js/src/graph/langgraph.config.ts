// 解析标准 langgraph.json（兼容 langgraphjs）并输出图规范映射
// 目标：允许 JS Worker 使用与 langgraphjs 一致的项目配置来注册图
// 支持格式：
// {
//   "graphs": {
//     "examples-echo": "./index.ts:graph",
//     "another": { "path": "./src/graph.ts", "export": "build", "lang": "js" }
//   },
//   "env": { ... },
//   "dependencies": { ... }
// }
// 注意：本解析器只处理 lang=="js" 或未指定语言的条目；其他语言条目将忽略。

import * as fs from "node:fs";
import * as path from "node:path";

interface LanggraphJson {
  graphs?: Record<
    string,
    string | { path: string; export?: string; lang?: string }
  >;
  env?: Record<string, string>;
  dependencies?: Record<string, unknown>;
}

/**
 * 解析 langgraph.json 并生成 worker-js 可识别的图规范映射。
 * 输出形如：{ graphId: "relativePath[:exportSymbol]" }
 */
export function parseLanggraphJson(configPath: string): {
  specs: Record<string, string>;
  baseDir: string;
} {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`langgraph.json 未找到：${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf-8");
  const parsed = JSON.parse(raw) as LanggraphJson;
  const baseDir = path.dirname(abs);

  const specs: Record<string, string> = {};
  const graphs = parsed.graphs ?? {};
  for (const [graphId, entry] of Object.entries(graphs)) {
    let lang: string | undefined;
    let p: string;
    let exp: string | undefined;

    if (typeof entry === "string") {
      // 允许 "./file.ts:export" 或 "./file.ts"
      const [maybePath, maybeExport] = entry.split(":");
      p = maybePath;
      exp = entry.includes(":") ? maybeExport : undefined;
    } else {
      p = entry.path;
      exp = entry.export;
      lang = entry.lang;
    }

    // 仅处理 JS/未指定语言的条目
    if (
      lang &&
      lang.toLowerCase() !== "js" &&
      lang.toLowerCase() !== "javascript" &&
      lang.toLowerCase() !== "ts" &&
      lang.toLowerCase() !== "typescript"
    ) {
      continue;
    }

    // 规范化为相对路径，以便在 worker 中基于 baseDir 解析
    const rel = path.normalize(p);
    specs[graphId] = exp ? `${rel}:${exp}` : rel;
  }
  return { specs, baseDir };
}

/**
 * 尝试读取默认路径的 langgraph.json（当前工作目录），若存在则返回映射；否则返回 null。
 */
export function tryParseDefaultLanggraphJson(): {
  specs: Record<string, string>;
  baseDir: string;
} | null {
  const defaultPath = path.join(process.cwd(), "langgraph.json");
  if (!fs.existsSync(defaultPath)) return null;
  return parseLanggraphJson(defaultPath);
}
