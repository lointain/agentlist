// 内容类型校正中间件
// 说明：从原来的 http/middleware.mts 拆分到独立文件，保持平台兼容
import type { MiddlewareHandler } from "hono";

// 与原实现一致：某些客户端会以 text/plain 发送 JSON，统一修正为 application/json
export const ensureContentType = (): MiddlewareHandler => {
  return async (c, next) => {
    if (
      c.req.header("content-type")?.startsWith("text/plain") &&
      c.req.method !== "GET" &&
      c.req.method !== "OPTIONS"
    ) {
      c.req.raw.headers.set("content-type", "application/json");
    }
    await next();
  };
};
