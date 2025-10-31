import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { Pool } from "pg";
import { webcrypto as crypto } from "node:crypto";
import { AuthStore } from "../storage/auth.mjs";

const api = new Hono();

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  username: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

api.post("/register", zValidator("json", RegisterSchema), async (c) => {
  const payload = c.req.valid("json");
  const pg: Pool | undefined =
    (c.var.postgres as any)?.pool ?? (c.get("postgres") as any)?.pool;
  if (!pg) throw new HTTPException(500, { message: "数据库连接缺失" });
  const store = new AuthStore(pg);

  // 简化：使用明文密码哈希存储，请在生产环境替换为 bcrypt/scrypt
  const hash = await simpleHash(payload.password);
  const user = await store.createUser(payload.email, hash, {
    username: payload.username,
  });
  // 默认授予基本角色
  await store.assignRoleToUser(user.id, "user");
  await store.grantPermissionToRole("user", "store:get");
  await store.grantPermissionToRole("user", "store:search");
  return c.json({ id: user.id, email: user.email, username: user.username });
});

api.post("/login", zValidator("json", LoginSchema), async (c) => {
  const payload = c.req.valid("json");
  const pg: Pool | undefined =
    (c.var.postgres as any)?.pool ?? (c.get("postgres") as any)?.pool;
  if (!pg) throw new HTTPException(500, { message: "数据库连接缺失" });
  const store = new AuthStore(pg);
  const user = await store.findUserByEmail(payload.email);
  if (!user) throw new HTTPException(401, { message: "用户不存在" });
  const ok = await verifySimpleHash(payload.password, user.password_hash);
  if (!ok) throw new HTTPException(401, { message: "密码错误" });
  const session = await store.createSession(user.id);
  return c.json({ token: session.token, expires_at: session.expires_at });
});

api.post("/logout", async (c) => {
  const authHeader =
    c.req.header("authorization") || c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return c.json({ ok: true });
  const token = authHeader.slice("Bearer ".length).trim();
  const pg: Pool | undefined =
    (c.var.postgres as any)?.pool ?? (c.get("postgres") as any)?.pool;
  if (!pg) throw new HTTPException(500, { message: "数据库连接缺失" });
  const store = new AuthStore(pg);
  await store.revokeSession(token);
  return c.json({ ok: true });
});

api.get("/me", async (c) => {
  const auth = c.get("auth") as any;
  if (!auth) throw new HTTPException(401, { message: "未认证" });
  return c.json({ user: auth.user, scopes: auth.scopes });
});

async function simpleHash(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySimpleHash(
  password: string,
  hash: string
): Promise<boolean> {
  const h = await simpleHash(password);
  return h === hash;
}

export default api;
