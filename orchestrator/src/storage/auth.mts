import { Pool } from "pg";
import crypto from "node:crypto";

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

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createUser(
    email: string,
    passwordHash: string,
    opts?: { username?: string; metadata?: Record<string, any> }
  ): Promise<UserRecord> {
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO users (id, email, username, password_hash, status, metadata)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id, email, username, password_hash, status, metadata`,
      [
        id,
        email,
        opts?.username ?? null,
        passwordHash,
        JSON.stringify(opts?.metadata ?? {}),
      ]
    );
    return res.rows[0] as UserRecord;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.pool.query(
      `SELECT id, email, username, password_hash, status, metadata FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    return res.rows[0] ?? null;
  }

  async createSession(
    userId: string,
    ttlSeconds = 60 * 60 * 24 * 7
  ): Promise<SessionRecord> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, userId, expiresAt]
    );
    return { token, user_id: userId, expires_at: expiresAt };
  }

  async getSession(token: string): Promise<SessionRecord | null> {
    const res = await this.pool.query(
      `SELECT token, user_id, expires_at FROM sessions WHERE token = $1 AND expires_at > NOW() LIMIT 1`,
      [token]
    );
    return res.rows[0] ?? null;
  }

  async revokeSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }

  async getUserPermissions(userId: string): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT p.name as permission
       FROM user_roles ur
       INNER JOIN role_permissions rp ON ur.role_id = rp.role_id
       INNER JOIN permissions p ON rp.permission_id = p.id
       WHERE ur.user_id = $1`,
      [userId]
    );
    return res.rows.map((r) => r.permission as string);
  }

  async ensureRole(name: string): Promise<string> {
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO roles (id, name)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [id, name]
    );
    return res.rows[0].id as string;
  }

  async ensurePermission(name: string): Promise<string> {
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO permissions (id, name)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [id, name]
    );
    return res.rows[0].id as string;
  }

  async assignRoleToUser(userId: string, roleName: string): Promise<void> {
    const roleId = await this.ensureRole(roleName);
    await this.pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, roleId]
    );
  }

  async grantPermissionToRole(
    roleName: string,
    permissionName: string
  ): Promise<void> {
    const roleId = await this.ensureRole(roleName);
    const permId = await this.ensurePermission(permissionName);
    await this.pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [roleId, permId]
    );
  }
}
