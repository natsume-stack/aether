import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { parse, serialize } from 'cookie';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import {
  effectivePlayerAdminCapabilities,
  normalizePlayerAdminCapabilities,
  type PlayerAdminCapability,
  type PlayerAdminRole,
} from '@box/player-policy';
import { requestClientAddress } from './client-address';
import { publicPath } from './public-path';
import {
  PlayerAdminRequestError,
  playerAdminSessionError,
  playerAdminRequestError,
} from './player-admin-errors';

const ADMIN_SESSION_COOKIE = 'box_local_admin_session';
const ADMIN_CSRF_COOKIE = 'box_local_admin_csrf';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_LIMIT = 10;
const LOGIN_ACCOUNT_LIMIT = 5;
const schemaPattern = /^[a-z_][a-z0-9_]{0,62}$/;
const usernamePattern = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlayerAdminIdentity = {
  id: string;
  username: string;
  displayName: string;
  role: PlayerAdminRole;
  permissions: PlayerAdminCapability[];
  permissionGroupId?: string;
  permissionGroupName?: string;
  status: 'active' | 'disabled';
  credential: 'account' | 'owner-session';
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
  lastLoginIp?: string;
  loginCount?: number;
};

type PlayerAdminAccountRole = Exclude<PlayerAdminRole, 'owner'>;

export type PlayerAdminPermissionGroup = {
  id: string;
  name: string;
  permissions: PlayerAdminCapability[];
  adminCount: number;
  createdAt?: string;
  updatedAt?: string;
};

export { PlayerAdminRequestError, playerAdminRequestError } from './player-admin-errors';

type AdminRow = QueryResultRow & {
  id: string;
  username: string;
  display_name: string;
  role: PlayerAdminAccountRole;
  permissions: string[];
  permission_group_id?: string | null;
  permission_group_name?: string | null;
  permission_group_permissions?: string[] | null;
  status: 'active' | 'disabled';
  password_salt: string;
  password_hash: string;
  created_at?: Date | string;
  updated_at?: Date | string;
  last_login_at?: Date | string | null;
  last_login_ip?: string;
  login_count?: number | string;
};

type PermissionGroupRow = QueryResultRow & {
  id: string;
  name: string;
  permissions: string[];
  admin_count?: number | string;
  created_at?: Date | string;
  updated_at?: Date | string;
};

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

function identitySchema() {
  const value = process.env.BOX_IDENTITY_DATABASE_SCHEMA || 'box_identity';
  if (!schemaPattern.test(value)) {
    throw new Error('BOX_IDENTITY_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier');
  }
  return value;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function table(name: string) {
  return `${quoteIdentifier(identitySchema())}.${quoteIdentifier(name)}`;
}

function database() {
  const connectionString = (process.env.BOX_DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('玩家管理需要配置 PostgreSQL');
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Math.max(1, Math.min(4, Number(process.env.BOX_DATABASE_POOL_SIZE) || 4)),
      application_name: 'box-local-player-admin-identity',
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl:
        process.env.BOX_DATABASE_SSL === 'true'
          ? {
              rejectUnauthorized:
                process.env.BOX_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
            }
          : false,
    });
    pool.on('error', (error) =>
      console.error('Player admin PostgreSQL error:', error.message),
    );
  }
  return pool;
}

async function initialize() {
  if (!initialized) {
    initialized = (async () => {
      const client = database();
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(identitySchema())}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_permission_groups')} (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          permissions TEXT[] NOT NULL DEFAULT '{}'::text[],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL DEFAULT ''
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS local_admin_permission_groups_name_lower
        ON ${table('admin_permission_groups')} (LOWER(name))
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_accounts')} (
          id UUID PRIMARY KEY,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
          permissions TEXT[] NOT NULL DEFAULT '{}'::text[],
          permission_group_id UUID REFERENCES ${table('admin_permission_groups')}(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_login_at TIMESTAMPTZ,
          last_login_ip TEXT NOT NULL DEFAULT '',
          login_count BIGINT NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL DEFAULT ''
        )
      `);
      await client.query(`
        ALTER TABLE ${table('admin_accounts')}
        ADD COLUMN IF NOT EXISTS permission_group_id UUID
        REFERENCES ${table('admin_permission_groups')}(id) ON DELETE SET NULL
      `);
      await client.query(`ALTER TABLE ${table('admin_accounts')}
        DROP COLUMN IF EXISTS console_login_enabled`);
      await client.query(`
        UPDATE ${table('admin_accounts')}
        SET role = 'admin', permissions = '{}'::text[], permission_group_id = NULL,
          updated_at = NOW()
        WHERE role = 'owner'
      `);
      await client.query(`
        ALTER TABLE ${table('admin_accounts')}
        DROP CONSTRAINT IF EXISTS admin_accounts_role_check
      `);
      await client.query(`
        ALTER TABLE ${table('admin_accounts')}
        ADD CONSTRAINT admin_accounts_role_check
        CHECK (role IN ('admin', 'moderator'))
      `);
      await client.query(`
        UPDATE ${table('admin_permission_groups')}
        SET permissions = ARRAY(
          SELECT DISTINCT capability
          FROM unnest(
            permissions
            || ARRAY['players.view', 'sessions.view']::text[]
            || CASE WHEN 'players.ban' = ANY(permissions)
              THEN ARRAY['account-bans.view']::text[] ELSE '{}'::text[] END
          ) AS capability
        )
        WHERE NOT ('players.view' = ANY(permissions))
          OR NOT ('sessions.view' = ANY(permissions))
          OR ('players.ban' = ANY(permissions) AND NOT ('account-bans.view' = ANY(permissions)))
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS local_admin_accounts_username_lower
        ON ${table('admin_accounts')} (LOWER(username))
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_sessions')} (
          token_hash TEXT PRIMARY KEY,
          admin_id UUID REFERENCES ${table('admin_accounts')}(id) ON DELETE CASCADE,
          owner_session BOOLEAN NOT NULL DEFAULT FALSE,
          csrf_hash TEXT NOT NULL,
          user_agent_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          absolute_expires_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_ip TEXT NOT NULL DEFAULT '',
          last_seen_ip TEXT NOT NULL DEFAULT ''
        )
      `);
      await client.query(`
        DELETE FROM ${table('admin_sessions')}
        WHERE (owner_session AND admin_id IS NOT NULL)
          OR (NOT owner_session AND admin_id IS NULL)
      `);
      await client.query(`
        ALTER TABLE ${table('admin_sessions')}
        DROP CONSTRAINT IF EXISTS admin_sessions_identity_check
      `);
      await client.query(`
        ALTER TABLE ${table('admin_sessions')}
        ADD CONSTRAINT admin_sessions_identity_check CHECK (
          (owner_session AND admin_id IS NULL)
          OR (NOT owner_session AND admin_id IS NOT NULL)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS local_admin_sessions_admin
        ON ${table('admin_sessions')} (admin_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_login_events')} (
          id BIGSERIAL PRIMARY KEY,
          admin_id UUID REFERENCES ${table('admin_accounts')}(id) ON DELETE SET NULL,
          username TEXT NOT NULL DEFAULT '',
          success BOOLEAN NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          ip_address TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS local_admin_login_events_created
        ON ${table('admin_login_events')} (created_at DESC)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_login_limits')} (
          scope TEXT NOT NULL,
          rate_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          reset_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (scope, rate_key)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table('admin_audit_events')} (
          id BIGSERIAL PRIMARY KEY,
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_id TEXT NOT NULL DEFAULT '',
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          ip_address TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS local_admin_audit_events_created
        ON ${table('admin_audit_events')} (created_at DESC)
      `);

      // Legacy moderator/admin rows remain valid player accounts, but their
      // player password and player session must never authorize this console.
      // Demoting them here makes that invariant visible throughout the UI.
      const legacyPlayers = await client.query<{ relation: string | null }>(
        'SELECT to_regclass($1) AS relation',
        [`${identitySchema()}.users`],
      );
      if (legacyPlayers.rows[0]?.relation) {
        await client.query(`
          UPDATE ${table('users')}
          SET role = 'player', admin_permissions = '{}'::text[], updated_at = NOW()
          WHERE role <> 'player' OR cardinality(admin_permissions) > 0
        `);
      }
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  await initialized;
}

function tokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function requestUserAgent(req: NextApiRequest) {
  return String(req.headers['user-agent'] || '').slice(0, 512);
}

function userAgentHash(req: NextApiRequest) {
  return tokenHash(requestUserAgent(req));
}

function secretsMatch(provided: string, expected: string) {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function derivePassword(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, value) =>
      error ? reject(error) : resolve(value as Buffer),
    );
  });
}

function secureCookie(req: NextApiRequest) {
  if (process.env.BOX_PLAYER_SERVICE_PUBLIC_URL?.startsWith('https://')) return true;
  if (process.env.BOX_TRUST_PROXY === 'true') {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return forwarded === 'https';
  }
  return false;
}

function appendCookie(res: NextApiResponse, value: string) {
  const current = res.getHeader('Set-Cookie');
  const values = !current ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  res.setHeader('Set-Cookie', [...values, value]);
}

function setSessionCookies(
  req: NextApiRequest,
  res: NextApiResponse,
  token: string,
  csrfToken: string,
) {
  appendCookie(
    res,
    serialize(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(req),
      // Prefix-aware: the browser stores and returns this cookie for the
      // public path (for example /csnjncsk/api/play-admin) only.
      path: publicPath('/api/play-admin'),
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    }),
  );
  appendCookie(
    res,
    serialize(ADMIN_CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      sameSite: 'strict',
      secure: secureCookie(req),
      path: '/',
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    }),
  );
}

export function clearPlayerAdminSession(req: NextApiRequest, res: NextApiResponse) {
  for (const [name, httpOnly, path] of [
    [ADMIN_SESSION_COOKIE, true, publicPath('/api/play-admin')],
    [ADMIN_CSRF_COOKIE, false, '/'],
  ] as const) {
    appendCookie(
      res,
      serialize(name, '', {
        httpOnly,
        sameSite: 'strict',
        secure: secureCookie(req),
        path,
        maxAge: 0,
      }),
    );
  }
}

function sessionToken(req: NextApiRequest) {
  return parse(req.headers.cookie || '')[ADMIN_SESSION_COOKIE] || '';
}

function csrfCookie(req: NextApiRequest) {
  return parse(req.headers.cookie || '')[ADMIN_CSRF_COOKIE] || '';
}

function toIdentity(row: AdminRow): PlayerAdminIdentity {
  const assignedPermissions = row.permission_group_id
    ? row.permission_group_permissions || []
    : row.permissions;
  return {
    id: String(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    permissions: effectivePlayerAdminCapabilities(row.role, assignedPermissions),
    permissionGroupId: row.permission_group_id || undefined,
    permissionGroupName: row.permission_group_name || undefined,
    status: row.status,
    credential: 'account',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    lastLoginAt: row.last_login_at
      ? new Date(row.last_login_at).toISOString()
      : undefined,
    lastLoginIp: row.last_login_ip || '',
    loginCount: Number(row.login_count || 0),
  };
}

function toPermissionGroup(row: PermissionGroupRow): PlayerAdminPermissionGroup {
  return {
    id: String(row.id),
    name: row.name,
    permissions: normalizePlayerAdminCapabilities(row.permissions),
    adminCount: Number(row.admin_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

function parsePermissionGroupId(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value);
  if (!uuidPattern.test(id)) {
    throw new PlayerAdminRequestError('权限组 ID 无效');
  }
  return id;
}

function requireOwnerIdentity(actor: PlayerAdminIdentity) {
  if (actor.role !== 'owner' || actor.credential !== 'owner-session') {
    throw new PlayerAdminRequestError(
      '此操作仅限服主密钥会话',
      403,
      'OWNER_SESSION_REQUIRED',
    );
  }
}

async function requirePermissionGroup(client: Pool | PoolClient, id: string | null) {
  if (!id) return;
  const result = await client.query(`
    SELECT 1 FROM ${table('admin_permission_groups')} WHERE id = $1
  `, [id]);
  if (!result.rowCount) throw new PlayerAdminRequestError('权限组不存在', 404);
}

async function findAdminAccount(client: Pool | PoolClient, id: string) {
  const result = await client.query<AdminRow>(`
    SELECT a.*, g.name AS permission_group_name,
      g.permissions AS permission_group_permissions
    FROM ${table('admin_accounts')} a
    LEFT JOIN ${table('admin_permission_groups')} g ON g.id = a.permission_group_id
    WHERE a.id = $1
  `, [id]);
  const row = result.rows[0];
  if (!row) throw new PlayerAdminRequestError('管理员账号不存在', 404);
  return row;
}

async function auditAdminAction(
  client: Pool | PoolClient,
  actor: PlayerAdminIdentity,
  action: string,
  targetId: string,
  details: Record<string, unknown> = {},
  req?: NextApiRequest,
) {
  await client.query(
    `
      INSERT INTO ${table('admin_audit_events')}
        (actor_id, action, target_id, details, ip_address)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
    [
      actor.id,
      action,
      targetId,
      JSON.stringify({
        ...details,
        outcome: 'success',
        actorUsername: actor.username,
        actorDisplayName: actor.displayName,
        actorRole: actor.role,
        actorUserAgent: req ? String(req.headers['user-agent'] || '').slice(0, 512) : '',
      }),
      req ? requestClientAddress(req).slice(0, 128) : '',
    ],
  );
}

function validateAccountInput(values: {
  username?: unknown;
  displayName?: unknown;
  password?: unknown;
  permissionGroupId?: unknown;
}) {
  const username = typeof values.username === 'string' ? values.username.trim() : '';
  const displayName =
    typeof values.displayName === 'string' ? values.displayName.trim() : '';
  const password = typeof values.password === 'string' ? values.password : '';
  if (!usernamePattern.test(username)) {
    throw new PlayerAdminRequestError('管理员用户名必须以字母开头，只能包含字母、数字和下划线，长度为 3 到 32');
  }
  if (!displayName || displayName.length > 32) {
    throw new PlayerAdminRequestError('管理员昵称长度必须为 1 到 32 个字符');
  }
  if (password.length < 12 || password.length > 128) {
    throw new PlayerAdminRequestError('管理员密码长度必须为 12 到 128 个字符');
  }
  return {
    username,
    displayName,
    password,
    role: 'moderator' as const,
    permissions: [],
    permissionGroupId: parsePermissionGroupId(values.permissionGroupId),
  };
}

async function consumeLoginLimit(scope: string, rateKey: string, maximum: number) {
  const result = await database().query<{ attempt_count: number; reset_at: Date }>(`
    INSERT INTO ${table('admin_login_limits')} AS limits
      (scope, rate_key, attempt_count, reset_at)
    VALUES ($1, $2, 1, NOW() + ($3 * INTERVAL '1 millisecond'))
    ON CONFLICT (scope, rate_key) DO UPDATE
    SET attempt_count = CASE WHEN limits.reset_at <= NOW() THEN 1 ELSE limits.attempt_count + 1 END,
        reset_at = CASE
          WHEN limits.reset_at <= NOW() THEN NOW() + ($3 * INTERVAL '1 millisecond')
          ELSE limits.reset_at
        END
    RETURNING attempt_count, reset_at
  `, [scope, rateKey, LOGIN_WINDOW_MS]);
  const entry = result.rows[0];
  return {
    allowed: Boolean(entry && entry.attempt_count <= maximum),
    retryAfterSeconds: entry
      ? Math.max(1, Math.ceil((entry.reset_at.getTime() - Date.now()) / 1000))
      : 1,
  };
}

async function resetLoginLimits(ip: string, username: string) {
  await database().query(`
    DELETE FROM ${table('admin_login_limits')}
    WHERE (scope = 'ip' AND rate_key = $1) OR (scope = 'account' AND rate_key = $2)
  `, [ip, username.toLowerCase()]);
}

async function createSession(
  req: NextApiRequest,
  res: NextApiResponse,
  adminId: string | null,
  ownerSession: boolean,
) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await database().query(`
    INSERT INTO ${table('admin_sessions')}
      (token_hash, admin_id, owner_session, csrf_hash, user_agent_hash,
       expires_at, absolute_expires_at, created_ip, last_seen_ip)
    VALUES ($1, $2, $3, $4, $5,
      NOW() + ($6 * INTERVAL '1 millisecond'),
      NOW() + ($7 * INTERVAL '1 millisecond'), $8, $8)
  `, [
    tokenHash(token),
    adminId,
    ownerSession,
    tokenHash(csrfToken),
    userAgentHash(req),
    SESSION_IDLE_MS,
    SESSION_ABSOLUTE_MS,
    requestClientAddress(req).slice(0, 128),
  ]);
  setSessionCookies(req, res, token, csrfToken);
}

export async function createPlayerAdminOwnerSession(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  await initialize();
  await createSession(req, res, null, true);
  return ownerIdentity();
}

function ownerIdentity(): PlayerAdminIdentity {
  return {
    id: 'server-owner',
    username: 'server-owner',
    displayName: '服主',
    role: 'owner',
    permissions: effectivePlayerAdminCapabilities('owner'),
    status: 'active',
    credential: 'owner-session',
  };
}

export async function loginPlayerAdmin(
  req: NextApiRequest,
  res: NextApiResponse,
  values: { username?: unknown; password?: unknown },
) {
  await initialize();
  const username = typeof values.username === 'string' ? values.username.trim() : '';
  const password = typeof values.password === 'string' ? values.password : '';
  const ip = requestClientAddress(req).slice(0, 128);
  const accountKey = username.toLowerCase().slice(0, 64);
  const [ipLimit, accountLimit] = await Promise.all([
    consumeLoginLimit('ip', ip, LOGIN_IP_LIMIT),
    consumeLoginLimit('account', accountKey, LOGIN_ACCOUNT_LIMIT),
  ]);
  if (!ipLimit.allowed || !accountLimit.allowed) {
    throw new PlayerAdminRequestError(
      '管理员登录尝试过多，请稍后再试',
      429,
      'ADMIN_RATE_LIMITED',
      Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds),
    );
  }
  const result = await database().query<AdminRow>(`
    SELECT a.*, g.name AS permission_group_name,
      g.permissions AS permission_group_permissions
    FROM ${table('admin_accounts')} a
    LEFT JOIN ${table('admin_permission_groups')} g ON g.id = a.permission_group_id
    WHERE LOWER(a.username) = LOWER($1)
  `, [username]);
  const row = result.rows[0];
  const fallbackSalt = 'box-local-missing-admin';
  const derived = await derivePassword(password, row?.password_salt || fallbackSalt);
  const expected = row
    ? Buffer.from(row.password_hash, 'base64url')
    : await derivePassword('box-local-invalid-admin-password', fallbackSalt);
  const passwordMatches =
    Boolean(row) &&
    derived.length === expected.length &&
    timingSafeEqual(derived, expected);
  const valid = passwordMatches && row?.status === 'active';
  await database().query(`
    INSERT INTO ${table('admin_login_events')}
      (admin_id, username, success, reason, ip_address, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    row?.id || null,
    username.slice(0, 64),
    valid,
    valid ? '' : row?.status === 'disabled' ? 'disabled' : 'invalid_credentials',
    ip,
    requestUserAgent(req),
  ]);
  if (!valid || !row) {
    throw new PlayerAdminRequestError(
      row?.status === 'disabled' && passwordMatches
        ? '该管理账号已被停用'
        : '管理员用户名或密码错误',
      401,
    );
  }

  await database().query(`
    UPDATE ${table('admin_accounts')}
    SET last_login_at = NOW(), last_login_ip = $2, login_count = login_count + 1,
      updated_at = NOW()
    WHERE id = $1
  `, [row.id, ip]);
  await resetLoginLimits(ip, username);
  await createSession(req, res, row.id, false);
  return toIdentity({
    ...row,
    last_login_at: new Date(),
    last_login_ip: ip,
    login_count: Number(row.login_count || 0) + 1,
  });
}

export async function resolvePlayerAdminSession(
  req: NextApiRequest,
  options: { requireCsrf?: boolean } = {},
) {
  await initialize();
  const token = sessionToken(req);
  if (!token) throw playerAdminSessionError('ADMIN_AUTH_REQUIRED');
  const result = await database().query<
    AdminRow & {
      owner_session: boolean;
      csrf_hash: string;
      user_agent_hash: string;
    }
  >(`
    SELECT s.owner_session, s.csrf_hash, s.user_agent_hash,
      a.id, a.username, a.display_name, a.role, a.permissions,
      a.permission_group_id, g.name AS permission_group_name,
      g.permissions AS permission_group_permissions, a.status,
      a.password_salt, a.password_hash, a.created_at, a.updated_at,
      a.last_login_at, a.last_login_ip, a.login_count
    FROM ${table('admin_sessions')} s
    LEFT JOIN ${table('admin_accounts')} a ON a.id = s.admin_id
    LEFT JOIN ${table('admin_permission_groups')} g ON g.id = a.permission_group_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
      AND s.absolute_expires_at > NOW()
  `, [tokenHash(token)]);
  const row = result.rows[0];
  if (
    !row ||
    (row.owner_session
      ? Boolean(row.id)
      : !row.id || row.status !== 'active')
  ) {
    throw playerAdminSessionError('ADMIN_AUTH_REQUIRED');
  }
  if (!secretsMatch(row.user_agent_hash, userAgentHash(req))) {
    await database().query(`DELETE FROM ${table('admin_sessions')} WHERE token_hash = $1`, [
      tokenHash(token),
    ]);
    throw playerAdminSessionError('ADMIN_SESSION_MISMATCH');
  }
  if (options.requireCsrf) {
    const header = req.headers['x-box-admin-csrf'];
    const provided = String(Array.isArray(header) ? header[0] : header || '');
    const cookie = csrfCookie(req);
    if (!provided || !cookie || !secretsMatch(provided, cookie)) {
      throw playerAdminSessionError('ADMIN_CSRF_INVALID');
    }
    if (!secretsMatch(tokenHash(provided), row.csrf_hash)) {
      throw playerAdminSessionError('ADMIN_CSRF_INVALID');
    }
  }
  await database().query(`
    UPDATE ${table('admin_sessions')}
    SET last_seen_at = NOW(), last_seen_ip = $2,
      expires_at = LEAST(
        NOW() + ($3 * INTERVAL '1 millisecond'),
        absolute_expires_at
      )
    WHERE token_hash = $1
  `, [tokenHash(token), requestClientAddress(req).slice(0, 128), SESSION_IDLE_MS]);
  return row.owner_session ? ownerIdentity() : toIdentity(row);
}

export async function logoutPlayerAdmin(req: NextApiRequest, res: NextApiResponse) {
  await initialize();
  const token = sessionToken(req);
  if (token) {
    await database().query(`DELETE FROM ${table('admin_sessions')} WHERE token_hash = $1`, [
      tokenHash(token),
    ]);
  }
  clearPlayerAdminSession(req, res);
}

export async function listPlayerAdminAccounts(actor: PlayerAdminIdentity) {
  requireOwnerIdentity(actor);
  await initialize();
  const result = await database().query<AdminRow>(`
    SELECT a.*, g.name AS permission_group_name,
      g.permissions AS permission_group_permissions
    FROM ${table('admin_accounts')} a
    LEFT JOIN ${table('admin_permission_groups')} g ON g.id = a.permission_group_id
    ORDER BY CASE a.role WHEN 'admin' THEN 0 ELSE 1 END,
      LOWER(a.username)
  `);
  return result.rows.map(toIdentity);
}

/** Internal repository access; callers must perform owner/runtime authorization before use. */
export async function playerAdminStore() {
  await initialize();
  return { pool: database(), table };
}

export async function createPlayerAdminAccount(
  values: {
    username?: unknown;
    displayName?: unknown;
    password?: unknown;
    permissionGroupId?: unknown;
  },
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  const input = validateAccountInput(values);
  const salt = randomBytes(16).toString('base64url');
  const hash = (await derivePassword(input.password, salt)).toString('base64url');
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    await requirePermissionGroup(client, input.permissionGroupId);
    const id = randomUUID();
    await client.query(`
      INSERT INTO ${table('admin_accounts')}
        (id, username, display_name, password_salt, password_hash,
         role, permissions, permission_group_id, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      id,
      input.username,
      input.displayName,
      salt,
      hash,
      input.role,
      input.permissionGroupId ? [] : input.permissions,
      input.permissionGroupId,
      actor.id,
    ]);
    const row = await findAdminAccount(client, id);
    const identity = toIdentity(row);
    await auditAdminAction(
      client,
      actor,
      'admin.account.create',
      identity.id,
      {
        username: identity.username,
        role: identity.role,
        permissionGroupId: identity.permissionGroupId || null,
      },
      req,
    );
    await client.query('COMMIT');
    return identity;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new PlayerAdminRequestError('管理员用户名已经存在', 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePlayerAdminAccount(
  id: string,
  values: {
    displayName?: unknown;
    password?: unknown;
    permissionGroupId?: unknown;
    status?: unknown;
  },
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  if (!uuidPattern.test(id)) {
    throw new PlayerAdminRequestError('管理员账号 ID 无效');
  }
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${table('admin_accounts')} IN SHARE ROW EXCLUSIVE MODE`);
    const current = await client.query<AdminRow>(`
      SELECT * FROM ${table('admin_accounts')} WHERE id = $1
    `, [id]);
    const row = current.rows[0];
    if (!row) throw new PlayerAdminRequestError('管理员账号不存在', 404);
    const displayName =
      values.displayName === undefined
        ? row.display_name
        : typeof values.displayName === 'string'
          ? values.displayName.trim()
          : '';
    if (!displayName || displayName.length > 32) {
      throw new PlayerAdminRequestError('管理员昵称长度必须为 1 到 32 个字符');
    }
    // 管理账号的权限始终由权限组决定；历史上的 admin 账号会在下一次保存时收敛到此模型。
    const role: PlayerAdminAccountRole = 'moderator';
    const status = (values.status === undefined ? row.status : values.status) as
      | 'active'
      | 'disabled';
    if (!['active', 'disabled'].includes(String(status))) {
      throw new PlayerAdminRequestError('管理员状态无效');
    }
    const permissions = role === 'moderator'
      ? normalizePlayerAdminCapabilities(row.permissions)
      : [];
    const permissionGroupId =
      role !== 'moderator'
        ? null
        : values.permissionGroupId === undefined
          ? row.permission_group_id || null
          : parsePermissionGroupId(values.permissionGroupId);
    await requirePermissionGroup(client, permissionGroupId);
    const password = values.password;
    let salt = row.password_salt;
    let hash = row.password_hash;
    if (password !== undefined) {
      if (
        typeof password !== 'string' ||
        password.length < 12 ||
        password.length > 128
      ) {
        throw new PlayerAdminRequestError('管理员密码长度必须为 12 到 128 个字符');
      }
      salt = randomBytes(16).toString('base64url');
      hash = (await derivePassword(password, salt)).toString('base64url');
    }
    const effectivePermissions = permissionGroupId ? [] : permissions;
    const unchanged = password === undefined
      && displayName === row.display_name
      && role === row.role
      && status === row.status
      && permissionGroupId === (row.permission_group_id || null)
      && JSON.stringify(effectivePermissions) === JSON.stringify(row.permissions || []);
    if (unchanged) {
      const identity = toIdentity(await findAdminAccount(client, id));
      await client.query('COMMIT');
      return identity;
    }
    await client.query(`
      UPDATE ${table('admin_accounts')}
      SET display_name = $2, role = $3, permissions = $4,
        permission_group_id = $5, status = $6,
        password_salt = $7, password_hash = $8, updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      displayName,
      role,
      effectivePermissions,
      permissionGroupId,
      status,
      salt,
      hash,
    ]);
    if (password !== undefined || status === 'disabled') {
      await client.query(`DELETE FROM ${table('admin_sessions')} WHERE admin_id = $1`, [id]);
    }
    const updated = await findAdminAccount(client, id);
    const identity = toIdentity(updated);
    await auditAdminAction(
      client,
      actor,
      'admin.account.update',
      id,
      {
        username: identity.username,
        displayName: identity.displayName,
        role: identity.role,
        status: identity.status,
        permissionGroupId: identity.permissionGroupId || null,
        passwordReset: password !== undefined,
      },
      req,
    );
    await client.query('COMMIT');
    return identity;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Changes only the authenticated administrator's own password and invalidates every session. */
export async function changeOwnPlayerAdminPassword(
  actor: PlayerAdminIdentity,
  values: { currentPassword?: unknown; newPassword?: unknown },
  req?: NextApiRequest,
) {
  if (actor.credential !== 'account') {
    throw new PlayerAdminRequestError('服主密钥会话不能修改管理员密码', 403);
  }
  const currentPassword = typeof values.currentPassword === 'string' ? values.currentPassword : '';
  const newPassword = typeof values.newPassword === 'string' ? values.newPassword : '';
  if (!currentPassword) throw new PlayerAdminRequestError('请输入当前密码');
  if (newPassword.length < 12 || newPassword.length > 128) {
    throw new PlayerAdminRequestError('管理员密码长度必须为 12 到 128 个字符');
  }
  await initialize();
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<AdminRow>(`
      SELECT * FROM ${table('admin_accounts')} WHERE id = $1 FOR UPDATE
    `, [actor.id]);
    const row = result.rows[0];
    if (!row || row.status !== 'active') {
      throw new PlayerAdminRequestError('当前管理账号不可用', 403);
    }
    const supplied = await derivePassword(currentPassword, row.password_salt);
    const expected = Buffer.from(row.password_hash, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new PlayerAdminRequestError('当前密码不正确', 400);
    }
    const salt = randomBytes(16).toString('base64url');
    const hash = (await derivePassword(newPassword, salt)).toString('base64url');
    await client.query(`
      UPDATE ${table('admin_accounts')}
      SET password_salt = $2, password_hash = $3, updated_at = NOW()
      WHERE id = $1
    `, [actor.id, salt, hash]);
    await client.query(`DELETE FROM ${table('admin_sessions')} WHERE admin_id = $1`, [actor.id]);
    await auditAdminAction(
      client,
      actor,
      'admin.account.password.change',
      actor.id,
      { username: row.username },
      req,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePlayerAdminAccount(
  id: string,
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  if (!uuidPattern.test(id)) {
    throw new PlayerAdminRequestError('管理员账号 ID 无效');
  }
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${table('admin_accounts')} IN SHARE ROW EXCLUSIVE MODE`);
    const current = await client.query<AdminRow>(`
      SELECT * FROM ${table('admin_accounts')} WHERE id = $1
    `, [id]);
    const row = current.rows[0];
    if (!row) throw new PlayerAdminRequestError('管理员账号不存在', 404);
    const deleted = await client.query(`
      DELETE FROM ${table('admin_accounts')} WHERE id = $1 RETURNING id
    `, [id]);
    if (!deleted.rowCount) throw new PlayerAdminRequestError('管理员账号不存在', 404);
    await auditAdminAction(
      client,
      actor,
      'admin.account.delete',
      id,
      { username: row.username, displayName: row.display_name, role: row.role },
      req,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function permissionGroupName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 32) {
    throw new PlayerAdminRequestError('权限组名称长度必须为 1 到 32 个字符');
  }
  return name;
}

export async function listPlayerAdminPermissionGroups(actor: PlayerAdminIdentity) {
  requireOwnerIdentity(actor);
  await initialize();
  const result = await database().query<PermissionGroupRow>(`
    SELECT g.*, COUNT(a.id)::text AS admin_count
    FROM ${table('admin_permission_groups')} g
    LEFT JOIN ${table('admin_accounts')} a ON a.permission_group_id = g.id
    GROUP BY g.id
    ORDER BY LOWER(g.name)
  `);
  return result.rows.map(toPermissionGroup);
}

export async function createPlayerAdminPermissionGroup(
  values: { name?: unknown; permissions?: unknown },
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  const name = permissionGroupName(values.name);
  const permissions = normalizePlayerAdminCapabilities(values.permissions);
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<PermissionGroupRow>(`
      INSERT INTO ${table('admin_permission_groups')}
        (id, name, permissions, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [randomUUID(), name, permissions, actor.id]);
    const group = toPermissionGroup(result.rows[0]);
    await auditAdminAction(
      client,
      actor,
      'admin.permission-group.create',
      group.id,
      { name: group.name, permissions: group.permissions },
      req,
    );
    await client.query('COMMIT');
    return group;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new PlayerAdminRequestError('权限组名称已经存在', 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePlayerAdminPermissionGroup(
  id: string,
  values: { name?: unknown; permissions?: unknown },
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  if (!uuidPattern.test(id)) throw new PlayerAdminRequestError('权限组 ID 无效');
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<PermissionGroupRow>(`
      SELECT * FROM ${table('admin_permission_groups')} WHERE id = $1 FOR UPDATE
    `, [id]);
    const row = current.rows[0];
    if (!row) throw new PlayerAdminRequestError('权限组不存在', 404);
    const name = values.name === undefined ? row.name : permissionGroupName(values.name);
    const permissions =
      values.permissions === undefined
        ? normalizePlayerAdminCapabilities(row.permissions)
        : normalizePlayerAdminCapabilities(values.permissions);
    const unchanged = name === row.name
      && JSON.stringify(permissions) === JSON.stringify(normalizePlayerAdminCapabilities(row.permissions));
    if (unchanged) {
      const adminCount = await client
        .query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM ${table('admin_accounts')}
          WHERE permission_group_id = $1
        `, [id])
        .then((count) => count.rows[0]?.count || '0');
      const group = toPermissionGroup({ ...row, admin_count: adminCount });
      await client.query('COMMIT');
      return group;
    }
    const result = await client.query<PermissionGroupRow>(`
      UPDATE ${table('admin_permission_groups')}
      SET name = $2, permissions = $3, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, name, permissions]);
    const group = toPermissionGroup({
      ...result.rows[0],
      admin_count: await client
        .query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM ${table('admin_accounts')}
          WHERE permission_group_id = $1
        `, [id])
        .then((count) => count.rows[0]?.count || '0'),
    });
    await auditAdminAction(
      client,
      actor,
      'admin.permission-group.update',
      id,
      {
        before: {
          name: row.name,
          permissions: normalizePlayerAdminCapabilities(row.permissions),
        },
        after: { name: group.name, permissions: group.permissions },
        affectedAdminCount: group.adminCount,
      },
      req,
    );
    await client.query('COMMIT');
    return group;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new PlayerAdminRequestError('权限组名称已经存在', 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePlayerAdminPermissionGroup(
  id: string,
  actor: PlayerAdminIdentity,
  req?: NextApiRequest,
) {
  requireOwnerIdentity(actor);
  await initialize();
  if (!uuidPattern.test(id)) throw new PlayerAdminRequestError('权限组 ID 无效');
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<PermissionGroupRow>(`
      SELECT * FROM ${table('admin_permission_groups')} WHERE id = $1 FOR UPDATE
    `, [id]);
    const row = current.rows[0];
    if (!row) throw new PlayerAdminRequestError('权限组不存在', 404);
    const adminCount = Number(await client
      .query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM ${table('admin_accounts')}
        WHERE permission_group_id = $1
      `, [id])
      .then((count) => count.rows[0]?.count || '0'));
    if (adminCount > 0) {
      throw new PlayerAdminRequestError(
        `该权限组仍有 ${adminCount} 个管理账号使用，无法删除`,
        409,
      );
    }
    const deleted = await client.query(`
      DELETE FROM ${table('admin_permission_groups')} WHERE id = $1 RETURNING id
    `, [id]);
    if (!deleted.rowCount) throw new PlayerAdminRequestError('权限组不存在', 404);
    await auditAdminAction(
      client,
      actor,
      'admin.permission-group.delete',
      id,
      { name: row.name },
      req,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
