// CORS 中间件封装
// 说明：从原来的 http/middleware.mts 拆分到独立文件，保留行为一致
import type { MiddlewareHandler } from "hono";
import { cors as honoCors } from "hono/cors";

// 导出与原始函数同名的 cors 工具，保持 API 不变
export const cors = (
  cors:
    | {
        allow_origins?: string[];
        allow_origin_regex?: string;
        allow_methods?: string[];
        allow_headers?: string[];
        allow_credentials?: boolean;
        expose_headers?: string[];
        max_age?: number;
      }
    | undefined
): MiddlewareHandler => {
  // 没有配置时，走默认开放策略
  if (cors == null) {
    return honoCors({
      origin: "*",
      exposeHeaders: ["content-location", "x-pagination-total"],
    });
  }

  // 可选正则匹配 origin
  const originRegex = cors.allow_origin_regex
    ? new RegExp(cors.allow_origin_regex)
    : undefined;

  const origin = originRegex
    ? (origin: string) => {
        originRegex.lastIndex = 0;
        if (originRegex.test(origin)) return origin;
        return undefined;
      }
    : cors.allow_origins;

  // 补齐建议暴露的头部，保持与平台一致
  if (cors.expose_headers?.length) {
    const headersSet = new Set(cors.expose_headers.map((h) => h.toLowerCase()));
    if (!headersSet.has("content-location")) {
      console.warn(
        "Adding missing `Content-Location` header in `cors.expose_headers`."
      );
      cors.expose_headers.push("content-location");
    }
    if (!headersSet.has("x-pagination-total")) {
      console.warn(
        "Adding missing `X-Pagination-Total` header in `cors.expose_headers`."
      );
      cors.expose_headers.push("x-pagination-total");
    }
  }

  const config: Parameters<typeof honoCors>[0] = { origin: origin ?? "*" };
  if (cors.max_age != null) config.maxAge = cors.max_age;
  if (cors.allow_methods != null) config.allowMethods = cors.allow_methods;
  if (cors.allow_headers != null) config.allowHeaders = cors.allow_headers;
  if (cors.expose_headers != null) config.exposeHeaders = cors.expose_headers;
  if (cors.allow_credentials != null) config.credentials = cors.allow_credentials;

  return honoCors(config);
};