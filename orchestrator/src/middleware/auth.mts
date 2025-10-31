import { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { Pool } from "pg";
import { AuthStore } from "../storage/auth.mts";

export interface AuthUser {
  id: string;
  email?: string;
  identity?: string;
}

export interface AuthContext {
  user: AuthUser;
  scopes: string[];
}

export function ensureAuth(options?: { exempt?: string[] }): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const exempt = options?.exempt ?? [];
    const isExempt = exempt.some((p) => matchPath(path, p));
    if (isExempt) return next();

    const authHeader =
      c.req.header("authorization") || c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "缺少认证令牌" });
    }
    const token = authHeader.slice("Bearer ".length).trim();

    const pg: Pool | undefined =
      (c.var.postgres as any)?.pool ?? (c.get("postgres") as any)?.pool;
    if (!pg) {
      throw new HTTPException(500, {
        message: "认证系统未初始化（数据库连接缺失）",
      });
    }
    const store = new AuthStore(pg);
    const session = await store.getSession(token);
    if (!session) {
      throw new HTTPException(401, { message: "会话不存在或已过期" });
    }
    const scopes = await store.getUserPermissions(session.user_id);
    const ctx: AuthContext = { user: { id: session.user_id }, scopes };
    c.set("auth", ctx);
    await next();
  };
}

export function requirePermission(c: any, permission: string): void {
  const auth: AuthContext | undefined = c.get("auth") as any;
  if (!auth) {
    throw new HTTPException(401, { message: "未认证" });
  }
  if (
    !auth.scopes.includes(permission) &&
    !auth.scopes.includes("*") &&
    !auth.scopes.includes(permission.replace(/:.+$/, ":*"))
  ) {
    throw new HTTPException(403, { message: `权限不足：需要 ${permission}` });
  }
}

function matchPath(path: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(base + "/");
  }
  return path === pattern;
}
