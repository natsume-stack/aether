import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class PlayerSelfServiceError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export function validateSelfPasswordInput(values: { currentPassword?: unknown; newPassword?: unknown }) {
  if (typeof values.currentPassword !== 'string' || !values.currentPassword.length || values.currentPassword.length > 128) {
    throw new PlayerSelfServiceError('请填写有效的原密码', 'INVALID_INPUT', 400);
  }
  if (typeof values.newPassword !== 'string' || values.newPassword.length < 10 || values.newPassword.length > 128) {
    throw new PlayerSelfServiceError('新密码长度必须为 10 到 128 位', 'INVALID_INPUT', 400);
  }
  if (values.currentPassword === values.newPassword) {
    throw new PlayerSelfServiceError('新密码不能与原密码相同', 'INVALID_INPUT', 400);
  }
  return { currentPassword: values.currentPassword, newPassword: values.newPassword };
}

export async function verifyLockedLoginPassword(
  locked: { password_salt: string; password_hash: string },
  previouslyVerified: { password_salt: string; password_hash: string },
  password: string,
  derivePassword: (password: string, salt: string) => Promise<Buffer>,
) {
  if (locked.password_hash === previouslyVerified.password_hash && locked.password_salt === previouslyVerified.password_salt) return true;
  const verified = await derivePassword(password, locked.password_salt);
  const expected = Buffer.from(locked.password_hash, 'base64url');
  return verified.length === expected.length && timingSafeEqual(verified, expected);
}

type PasswordChangeContext = {
  database: Pool;
  usersTable: string;
  sessionsTable: string;
  subjectId: string;
  sessionHash: string;
  absoluteSessionDays: number;
  derivePassword: (password: string, salt: string) => Promise<Buffer>;
  publishRevocation: (client: PoolClient, revoked: number) => Promise<void>;
};

/** Lock the account and current session before verifying credentials or revoking sessions. */
export async function changeSelfPassword(
  context: PasswordChangeContext,
  values: { currentPassword?: unknown; newPassword?: unknown },
) {
  const input = validateSelfPasswordInput(values);
  const client = await context.database.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query<{ password_salt: string; password_hash: string; status: string }>(`
      SELECT password_salt, password_hash, status FROM ${context.usersTable}
      WHERE principal_id = $1 FOR UPDATE
    `, [context.subjectId]);
    if (!account.rows[0]) throw new PlayerSelfServiceError('登录状态已失效，请重新登录', 'AUTH_REQUIRED', 401);
    if (account.rows[0].status !== 'active') throw new PlayerSelfServiceError('账号当前不可用', 'PLAYER_BANNED', 403);
    const session = await client.query(`
      SELECT 1 FROM ${context.sessionsTable}
      WHERE token_hash = $1 AND principal_id = $2 AND expires_at > NOW()
        AND created_at > NOW() - INTERVAL '${context.absoluteSessionDays} days'
      FOR UPDATE
    `, [context.sessionHash, context.subjectId]);
    if (!session.rows.length) throw new PlayerSelfServiceError('登录状态已失效，请重新登录', 'AUTH_REQUIRED', 401);
    const derived = await context.derivePassword(input.currentPassword, account.rows[0].password_salt);
    const expected = Buffer.from(account.rows[0].password_hash, 'base64url');
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      throw new PlayerSelfServiceError('原密码不正确', 'CURRENT_PASSWORD_INVALID', 400);
    }
    const salt = randomBytes(18).toString('base64url');
    const hash = (await context.derivePassword(input.newPassword, salt)).toString('base64url');
    await client.query(`
      UPDATE ${context.usersTable} SET password_salt = $2, password_hash = $3, updated_at = NOW()
      WHERE principal_id = $1
    `, [context.subjectId, salt, hash]);
    const sessions = await client.query(`DELETE FROM ${context.sessionsTable} WHERE principal_id = $1`, [context.subjectId]);
    await context.publishRevocation(client, sessions.rowCount || 0);
    await client.query('COMMIT');
    return { changed: true, reloginRequired: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
