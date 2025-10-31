import { Pool } from "pg";
import crypto from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, gt } from "drizzle-orm";
import {
  users,
  sessions,
  roles,
  permissions,
  user_roles,
  role_permissions,
} from "./schema.mjs";

export interface UserRecord {
  id: string;
  email: string;
  username?: string;
  password_hash: string;
  status: string;
  metadata?: Record<string, any>;
}

export interface SessionRecord {
  token: string;
  user_id: string;
  expires_at: string;
}

export class AuthStore {
  private pool: Pool;
  private db: ReturnType<typeof drizzle>;

  constructor(pool: Pool) {
    this.pool = pool;
    this.db = drizzle(pool);
  }

  async createUser(
    email: string,
    passwordHash: string,
    opts?: { username?: string; metadata?: Record<string, any> }
  ): Promise<UserRecord> {
    const id = crypto.randomUUID();
    const inserted = await this.db
      .insert(users)
      .values({
        id,
        email,
        username: opts?.username ?? null,
        password_hash: passwordHash,
        status: "active",
        metadata: (opts?.metadata ?? {}) as any,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { username: opts?.username ?? null },
      })
      .returning({
        id: users.id,
        email: users.email,
        username: users.username,
        password_hash: users.password_hash,
        status: users.status,
        metadata: users.metadata,
      });
    return inserted[0] as UserRecord;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        password_hash: users.password_hash,
        status: users.status,
        metadata: users.metadata,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return (rows[0] as UserRecord) ?? null;
  }

  async createSession(
    userId: string,
    ttlSeconds = 60 * 60 * 24 * 7
  ): Promise<SessionRecord> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.db.insert(sessions).values({
      token,
      user_id: userId,
      expires_at: expiresAt,
    });
    return { token, user_id: userId, expires_at: expiresAt.toISOString() };
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select({
        token: sessions.token,
        user_id: sessions.user_id,
        expires_at: sessions.expires_at,
      })
      .from(sessions)
      .where(
        and(eq(sessions.token, token), gt(sessions.expires_at, new Date()))
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.token, token));
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ permission: permissions.name })
      .from(user_roles)
      .innerJoin(
        role_permissions,
        eq(user_roles.role_id, role_permissions.role_id)
      )
      .innerJoin(
        permissions,
        eq(role_permissions.permission_id, permissions.id)
      )
      .where(eq(user_roles.user_id, userId));
    return rows.map((r) => r.permission as string);
  }

  async ensureRole(name: string): Promise<string> {
    const id = crypto.randomUUID();
    const rows = await this.db
      .insert(roles)
      .values({ id, name })
      .onConflictDoUpdate({ target: roles.name, set: { name } })
      .returning({ id: roles.id });
    return rows[0].id as string;
  }

  async ensurePermission(name: string): Promise<string> {
    const id = crypto.randomUUID();
    const rows = await this.db
      .insert(permissions)
      .values({ id, name })
      .onConflictDoUpdate({ target: permissions.name, set: { name } })
      .returning({ id: permissions.id });
    return rows[0].id as string;
  }

  async assignRoleToUser(userId: string, roleName: string): Promise<void> {
    const roleId = await this.ensureRole(roleName);
    const exists = await this.db
      .select({ user_id: user_roles.user_id })
      .from(user_roles)
      .where(
        and(eq(user_roles.user_id, userId), eq(user_roles.role_id, roleId))
      )
      .limit(1);
    if (!exists.length) {
      await this.db
        .insert(user_roles)
        .values({ user_id: userId, role_id: roleId });
    }
  }

  async grantPermissionToRole(
    roleName: string,
    permissionName: string
  ): Promise<void> {
    const roleId = await this.ensureRole(roleName);
    const permId = await this.ensurePermission(permissionName);
    const exists = await this.db
      .select({ role_id: role_permissions.role_id })
      .from(role_permissions)
      .where(
        and(
          eq(role_permissions.role_id, roleId),
          eq(role_permissions.permission_id, permId)
        )
      )
      .limit(1);
    if (!exists.length) {
      await this.db
        .insert(role_permissions)
        .values({ role_id: roleId, permission_id: permId });
    }
  }
}
