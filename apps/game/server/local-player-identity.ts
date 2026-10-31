import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { parse, serialize } from 'cookie';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import {
  createPlayerUserKey,
  signRuntimePlayerIdentity,
  type LocalPlayerRole,
  type LocalPlayerStatus,
  type RuntimePlayerIdentity,
} from '@box/utils/local-player-identity';
import {
  normalizePlayerAdminCapabilities,
  type PlayerAdminCapability,
} from '@box/player-policy';
import {
  normalizeCreatorCapabilities,
  type CreatorCapability,
} from '../shared/creator-policy';
import {
  normalizeCreatorCliCapabilities,
  type CreatorCliCapability,
} from '../shared/creator-cli-policy';
import { requestClientAddress } from './client-address';
import { hasTrustedPlayerAuthKey } from './player-auth-security';
import { PlayerAdminRequestError } from './player-admin-errors';
import { changeSelfPassword, PlayerSelfServiceError, verifyLockedLoginPassword } from './player-self-password';
import { applicationEndpoint, openTransfer, sealTransfer, transferChallenge, transferTokenPattern, type LoginSource } from './player-login-transfer';

const COOKIE_NAME = 'box_local_player_session';
const DEVICE_COOKIE_NAME = 'box_local_player_device';
const SESSION_IDLE_DAYS = 14;
const SESSION_ABSOLUTE_DAYS = 30;
const schemaPattern = /^[a-z_][a-z0-9_]{0,62}$/;
const usernamePattern = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
const displayNamePattern = /^.{1,32}$/;
const defaultBuiltInSkinId = 'explorer';
const builtInSkinIds = new Set([
  defaultBuiltInSkinId,
  'pilot',
  'cowboy',
  'chinese-doll',
  'pink-girl',
  'maid',
  'little-prince',
  'christmas-girl',
]);

/** Player identities are always single-device; management identities are separate. */
export function limitsSessionsToSingleDevice(_role: LocalPlayerRole | null | undefined) {
  return true;
}

type IdentityRow = QueryResultRow & {
  subject_id: string;
  user_id: string | number | null;
  username: string | null;
  box_id: string | null;
  user_key: string | null;
  display_name: string | null;
  avatar_hash: string | null;
  avatar_skin_id: string | null;
  role: LocalPlayerRole | null;
  status: LocalPlayerStatus | null;
  created_at?: string | Date;
  last_seen_at?: string | Date;
  registered_at?: string | Date;
  updated_at?: string | Date;
  first_seen_ip?: string | null;
  last_seen_ip?: string | null;
  registration_ip?: string | null;
  last_login_at?: string | Date | null;
  last_login_ip?: string | null;
  login_count?: string | number | null;
  active_session_count?: string | number | null;
  active_creator_token_count?: string | number | null;
  admin_note?: string | null;
  tags?: string[] | null;
  ban_reason?: string | null;
  banned_at?: string | Date | null;
  banned_until?: string | Date | null;
  admin_permissions?: string[] | null;
  creator_access?: boolean | null;
  creator_permissions?: string[] | null;
  creator_cli_permissions?: string[] | null;
};

export type PlayerAccountView = {
  subjectId: string;
  userId: string;
  username: string;
  boxId: string;
  displayName: string;
  avatarSkinId: string;
  role: LocalPlayerRole;
  status: LocalPlayerStatus;
  guest: boolean;
  userKey: string;
  createdAt?: string;
  lastSeenAt?: string;
  registeredAt?: string;
  updatedAt?: string;
  firstSeenIp: string;
  lastSeenIp: string;
  registrationIp: string;
  lastLoginAt?: string;
  lastLoginIp: string;
  loginCount: number;
  activeSessionCount: number;
  activeCreatorTokenCount: number;
  adminNote: string;
  tags: string[];
  banReason: string;
  bannedAt?: string;
  bannedUntil?: string;
  adminPermissions: PlayerAdminCapability[];
  creatorAccess: boolean;
  creatorPermissions: string[];
};

export type ManagedPlayerListOptions = {
  search?: string;
  page?: number;
  pageSize?: number;
  identity?: 'all' | 'user' | 'box' | 'banned';
  role?: 'all' | LocalPlayerRole;
  online?: 'all' | 'online' | 'offline';
  sort?: 'lastSeen' | 'registered' | 'displayName' | 'loginCount';
};

export type ManagedPlayerList = {
  players: PlayerAccountView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type IdentityBanListOptions = {
  search?: string;
  kind?: 'all' | 'ip' | 'device';
  page?: number;
  pageSize?: number;
};

export type IdentityBanList = {
  bans: Array<{
    id: string;
    kind: 'ip' | 'device';
    displayValue: string;
    reason: string;
    bannedAt: string;
    bannedUntil?: string;
    sourceSubjectId?: string;
    sourceDisplayName: string;
    sourceUsername: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type AdminActionContext = {
  ip: string;
  userAgent: string;
  deviceHash: string;
  subjectId?: string;
  actor?: string;
  actorDisplayName?: string;
  actorRole?: LocalPlayerRole | 'owner';
  actorPermissions?: PlayerAdminCapability[];
};

export type PlayerAdminActivity = {
  events: Array<{
    id: string;
    kind: 'login' | 'admin';
    action: string;
    actor: string;
    actorDisplayName: string;
    subjectId: string;
    displayName: string;
    username: string;
    ip: string;
    userAgent: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type ManagedPlayerDetails = {
  player: PlayerAccountView;
  cliTokens: CreatorCliTokenView[];
  sessions: Array<{
    sessionId: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    createdIp: string;
    lastSeenIp: string;
    userAgent: string;
    deviceHash: string;
    deviceId: string;
  }>;
  loginHistory: Array<{
    createdAt: string;
    ip: string;
    userAgent: string;
    deviceHash: string;
    deviceId: string;
  }>;
  adminHistory: Array<{
    id: string;
    action: string;
    actor: string;
    actorDisplayName: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
  relatedAccounts: Array<{
    subjectId: string;
    displayName: string;
    username: string;
    sharedIp: string;
    lastSeenAt: string;
  }>;
  identityBans: Array<{
    id: string;
    kind: 'ip' | 'device';
    displayValue: string;
    reason: string;
    bannedAt: string;
    bannedUntil?: string;
  }>;
};

export type PlayerAdminOverview = {
  totals: {
    identities: number;
    users: number;
    guests: number;
    banned: number;
    activeSessions: number;
    activeLast24Hours: number;
    newLast7Days: number;
    loginsLast24Hours: number;
    failedLoginsLast24Hours: number;
    uniqueLoginIpsLast7Days: number;
    moderators: number;
    admins: number;
  };
  recentLogins: Array<{
    subjectId: string;
    displayName: string;
    username: string;
    ip: string;
    userAgent: string;
    createdAt: string;
  }>;
  recentAudits: Array<{
    id: string;
    action: string;
    subjectId: string;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
  security: {
    topFailedIps: Array<{ ip: string; attempts: number; lastAttemptAt: string }>;
    sharedLoginIps: Array<{ ip: string; accounts: number; lastSeenAt: string }>;
    temporaryBansEndingSoon: number;
    expiredSessions: number;
  };
};

export class PlayerBannedError extends Error {
  readonly reason: string;
  readonly bannedUntil: string | null;

  constructor(reason: string, bannedUntil: string | Date | null | undefined, readonly kind: 'account' | 'ip' | 'device' = 'account') {
    super(kind === 'ip' ? 'IP_BANNED' : kind === 'device' ? 'DEVICE_BANNED' : 'PLAYER_BANNED');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PlayerBannedError';
    this.reason = reason.trim() || '未说明';
    this.bannedUntil = bannedUntil ? new Date(bannedUntil).toISOString() : null;
  }
}

let pool: Pool | null = null;
let initialized: Promise<void> | null = null;

function identitySecret() {
  const value = process.env.PERMISSION_TOKEN_SECRET || '';
  if (!value) {
    throw new Error('PERMISSION_TOKEN_SECRET is required for player identity');
  }
  return value;
}

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

function getPool() {
  const connectionString = (process.env.BOX_DATABASE_URL || '').trim();
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Math.max(1, Math.min(20, Number(process.env.BOX_DATABASE_POOL_SIZE) || 10)),
      application_name: 'box-local-player-identity',
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: process.env.BOX_DATABASE_SSL === 'true'
        ? { rejectUnauthorized: process.env.BOX_DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false,
    });
    pool.on('error', (error) => console.error('Player identity PostgreSQL error:', error.message));
  }
  return pool;
}

async function initialize() {
  const database = getPool();
  if (!database) return;
  if (!initialized) {
    initialized = (async () => {
      const schema = quoteIdentifier(identitySchema());
      await database.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('principals')} (
          id UUID PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('guest', 'user')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          first_seen_ip TEXT NOT NULL DEFAULT '',
          last_seen_ip TEXT NOT NULL DEFAULT ''
        )
      `);
      await database.query(`ALTER TABLE ${table('principals')} ADD COLUMN IF NOT EXISTS first_seen_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('principals')} ADD COLUMN IF NOT EXISTS last_seen_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('users')} (
          id BIGSERIAL PRIMARY KEY,
          principal_id UUID NOT NULL UNIQUE REFERENCES ${table('principals')}(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          avatar_hash TEXT NOT NULL DEFAULT '',
          avatar_skin_id TEXT NOT NULL DEFAULT 'explorer',
          role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'moderator', 'admin')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
          registration_ip TEXT NOT NULL DEFAULT '',
          last_login_at TIMESTAMPTZ,
          last_login_ip TEXT NOT NULL DEFAULT '',
          login_count BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS registration_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS last_login_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS login_count BIGINT NOT NULL DEFAULT 0`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS box_id TEXT`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS user_key TEXT`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS avatar_skin_id TEXT NOT NULL DEFAULT 'explorer'`);
      await database.query(`ALTER TABLE ${table('users')} ALTER COLUMN avatar_skin_id SET DEFAULT 'explorer'`);
      await database.query(`UPDATE ${table('users')} SET avatar_skin_id = $1 WHERE avatar_skin_id IS NULL OR avatar_skin_id <> ALL($2::text[])`, [defaultBuiltInSkinId, [...builtInSkinIds]]);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS admin_note TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS admin_permissions TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS creator_access BOOLEAN NOT NULL DEFAULT FALSE`);
      await database.query(`ALTER TABLE ${table('users')} ADD COLUMN IF NOT EXISTS creator_permissions TEXT[] NOT NULL DEFAULT '{}'::text[]`);
      await database.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS local_users_username_lower
        ON ${table('users')} (LOWER(username))
      `);
      await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS local_users_box_id
        ON ${table('users')} (box_id) WHERE box_id IS NOT NULL
      `);
      await database.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS local_users_user_key
        ON ${table('users')} (user_key) WHERE user_key IS NOT NULL AND user_key <> ''
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('sessions')} (
          token_hash TEXT PRIMARY KEY,
          principal_id UUID NOT NULL REFERENCES ${table('principals')}(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_ip TEXT NOT NULL DEFAULT '',
          last_seen_ip TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT ''
        )
      `);
      await database.query(`ALTER TABLE ${table('sessions')} ADD COLUMN IF NOT EXISTS created_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('sessions')} ADD COLUMN IF NOT EXISTS last_seen_ip TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('sessions')} ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT ''`);
      await database.query(`ALTER TABLE ${table('sessions')} ADD COLUMN IF NOT EXISTS device_hash TEXT NOT NULL DEFAULT ''`);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('login_transfers')} (
          code_hash TEXT PRIMARY KEY,
          session_hash TEXT NOT NULL REFERENCES ${table('sessions')}(token_hash) ON DELETE CASCADE,
          source TEXT NOT NULL,
          challenge TEXT NOT NULL,
          credentials TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_sessions_principal
        ON ${table('sessions')} (principal_id)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('creator_cli_tokens')} (
          id TEXT PRIMARY KEY,
          principal_id UUID NOT NULL REFERENCES ${table('principals')}(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          scopes TEXT[] NOT NULL DEFAULT '{}'::text[],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by TEXT NOT NULL DEFAULT '',
          last_used_at TIMESTAMPTZ,
          last_used_ip TEXT NOT NULL DEFAULT '',
          revoked_at TIMESTAMPTZ,
          revoked_by TEXT NOT NULL DEFAULT ''
        )
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_creator_cli_tokens_principal
        ON ${table('creator_cli_tokens')} (principal_id, created_at DESC)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('player_map_library')} (
          principal_id UUID NOT NULL REFERENCES ${table('principals')}(id) ON DELETE CASCADE,
          map_id TEXT NOT NULL,
          favorite BOOLEAN NOT NULL DEFAULT FALSE,
          last_played_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (principal_id, map_id)
        )
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_player_map_library_recent
        ON ${table('player_map_library')} (principal_id, last_played_at DESC)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('audit_logs')} (
          id BIGSERIAL PRIMARY KEY,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          subject_id UUID,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('login_events')} (
          id BIGSERIAL PRIMARY KEY,
          principal_id UUID NOT NULL REFERENCES ${table('principals')}(id) ON DELETE CASCADE,
          ip_address TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await database.query(`ALTER TABLE ${table('login_events')} ADD COLUMN IF NOT EXISTS device_hash TEXT NOT NULL DEFAULT ''`);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_login_events_principal_created
        ON ${table('login_events')} (principal_id, created_at DESC)
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_login_events_created
        ON ${table('login_events')} (created_at DESC)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('auth_failures')} (
          id BIGSERIAL PRIMARY KEY,
          username TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL,
          ip_address TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_auth_failures_created
        ON ${table('auth_failures')} (created_at DESC)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('auth_rate_limits')} (
          scope TEXT NOT NULL,
          rate_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          reset_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (scope, rate_key)
        )
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_auth_rate_limits_reset
        ON ${table('auth_rate_limits')} (reset_at)
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('player_revocations')} (
          id BIGSERIAL PRIMARY KEY,
          subject_id UUID NOT NULL,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS ${table('identity_bans')} (
          id BIGSERIAL PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('ip', 'device')),
          value_hash TEXT NOT NULL,
          display_value TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          banned_until TIMESTAMPTZ,
          created_by TEXT NOT NULL DEFAULT '',
          source_subject_id UUID,
          revoked_at TIMESTAMPTZ,
          revoked_by TEXT NOT NULL DEFAULT ''
        )
      `);
      await database.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS local_identity_bans_active
        ON ${table('identity_bans')} (kind, value_hash) WHERE revoked_at IS NULL
      `);
      await database.query(`CREATE INDEX IF NOT EXISTS local_identity_bans_source ON ${table('identity_bans')} (source_subject_id, banned_at DESC)`);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_player_revocations_created
        ON ${table('player_revocations')} (created_at DESC)
      `);
      await database.query(`
        CREATE INDEX IF NOT EXISTS local_audit_logs_created
        ON ${table('audit_logs')} (created_at DESC)
      `);
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  await initialized;
}

function sessionToken(req: NextApiRequest) {
  return parse(req.headers.cookie || '')[COOKIE_NAME] || '';
}

function deviceTokens(req: NextApiRequest) {
  const values = String(req.headers.cookie || '').split(';').map((entry) => {
    const at = entry.indexOf('=');
    if (at < 0 || entry.slice(0, at).trim() !== DEVICE_COOKIE_NAME) return '';
    return entry.slice(at + 1).trim();
  }).filter((value) => /^[A-Za-z0-9_-]{40,64}$/.test(value));
  return [...new Set(values)];
}

function deviceToken(req: NextApiRequest) {
  return deviceTokens(req)[0] || '';
}

function secretsMatch(provided: string, expected: string) {
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function isInternalIdentityRequest(req: NextApiRequest) {
  const authorization = String(req.headers.authorization || '');
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return Boolean(provided) && secretsMatch(provided, identitySecret());
}

function requestIp(req: NextApiRequest) {
  if (isInternalIdentityRequest(req)) {
    const internal = req.headers['x-box-player-ip'];
    const value = Array.isArray(internal) ? internal[0] : internal;
    if (value) return value.slice(0, 128);
  }
  return requestClientAddress(req, hasTrustedPlayerAuthKey(req)).slice(0, 128);
}

function requestUserAgent(req: NextApiRequest) {
  if (isInternalIdentityRequest(req)) {
    const internal = req.headers['x-box-player-user-agent'];
    const value = Array.isArray(internal) ? internal[0] : internal;
    if (value) return value.slice(0, 512);
  }
  return String(req.headers['user-agent'] || '').slice(0, 512);
}

export function createAdminActionContext(req: NextApiRequest): AdminActionContext {
  const token = deviceToken(req);
  return { ip: requestIp(req), userAgent: requestUserAgent(req), deviceHash: token ? tokenHash(token) : '' };
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function sessionDeviceBindingMatches(
  storedDeviceHash: string,
  currentDeviceToken: string,
) {
  if (!storedDeviceHash) return true;
  if (!currentDeviceToken) return false;
  return secretsMatch(storedDeviceHash, tokenHash(currentDeviceToken));
}

function appendCookie(res: NextApiResponse, value: string) {
  const current = res.getHeader('Set-Cookie');
  const values = !current ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  res.setHeader('Set-Cookie', [...values, value]);
}

function secureCookie(req: NextApiRequest) {
  if (process.env.BOX_SERVER_PUBLIC_URL?.startsWith('https://')) return true;
  if (isInternalIdentityRequest(req)) {
    const value = req.headers['x-box-player-proto'];
    return (Array.isArray(value) ? value[0] : value) === 'https';
  }
  if (process.env.BOX_TRUST_PROXY === 'true') {
    const value = req.headers['x-forwarded-proto'];
    return (Array.isArray(value) ? value[0] : value) === 'https';
  }
  return false;
}

function cookieDomain() {
  return process.env.BOX_PLAYER_COOKIE_DOMAIN?.trim() || '';
}

/**
 * A host-only cookie from before the shared-domain migration shadows the new
 * domain cookie on the host that originally set it: a stale session token can
 * win the cookie parse, and a host-only device token never reaches sibling
 * hosts (VOXA), where session-device binding then rejects a valid login.
 */
function expireHostOnlyCookie(req: NextApiRequest, res: NextApiResponse, name: string) {
  if (!cookieDomain()) return;
  appendCookie(res, serialize(name, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(req),
    path: '/',
    maxAge: 0,
  }));
}

function setSessionCookie(req: NextApiRequest, res: NextApiResponse, token: string) {
  expireHostOnlyCookie(req, res, COOKIE_NAME);
  appendCookie(res, serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(req),
    path: '/',
    ...(cookieDomain()
      ? { domain: cookieDomain() }
      : {}),
    maxAge: SESSION_IDLE_DAYS * 24 * 60 * 60,
  }));
}

function ensureDeviceToken(req: NextApiRequest, res: NextApiResponse, migrate = false) {
  const domain = cookieDomain();
  const existing = deviceToken(req);
  // Only session-creating requests migrate a host-only device token to the
  // shared domain; internal identity reads must never rewrite it, because the
  // first duplicate in the cookie header belongs to another browser host and
  // would break the session's device binding.
  if (existing && !(domain && migrate)) return existing;
  const token = existing || randomBytes(32).toString('base64url');
  appendCookie(res, serialize(DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(req),
    path: '/',
    ...(domain ? { domain } : {}),
    maxAge: 365 * 24 * 60 * 60,
  }));
  return token;
}

function clearSessionCookie(req: NextApiRequest, res: NextApiResponse) {
  expireHostOnlyCookie(req, res, COOKIE_NAME);
  appendCookie(res, serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(req),
    path: '/',
    ...(cookieDomain()
      ? { domain: cookieDomain() }
      : {}),
    maxAge: 0,
  }));
}

function normalizeSubjectId(value: string) {
  return value.replace(/-/g, '').toLowerCase();
}

function rowToIdentity(row: IdentityRow): RuntimePlayerIdentity {
  const subjectId = normalizeSubjectId(row.subject_id);
  return {
    subjectId,
    userId: row.user_id == null ? '' : String(row.user_id),
    username: row.username || '',
    boxId: row.box_id || '',
    userKey: row.user_key || createPlayerUserKey(subjectId, identitySecret()),
    displayName: row.display_name || '',
    // Profile avatars are represented by the selected built-in skin. Ignore
    // legacy uploaded values so they cannot bloat runtime identity assertions.
    avatar: '',
    avatarSkinId: builtInSkinIds.has(row.avatar_skin_id || '') ? row.avatar_skin_id! : defaultBuiltInSkinId,
    creatorAccess: row.creator_access === true,
    creatorPermissions: normalizeCreatorCapabilities(row.creator_permissions),
    creatorCliPermissions: normalizeCreatorCliCapabilities(row.creator_cli_permissions),
    role: row.role || 'player',
    status: row.status || 'active',
    expiresAt: 0,
  };
}

function toView(identity: RuntimePlayerIdentity, dates: Partial<IdentityRow> = {}): PlayerAccountView {
  const iso = (value?: string | Date | null) => value ? new Date(value).toISOString() : undefined;
  return {
    subjectId: identity.subjectId,
    userId: identity.userId,
    username: identity.username,
    boxId: identity.boxId,
    displayName: identity.displayName,
    avatarSkinId: identity.avatarSkinId,
    role: identity.role,
    status: identity.status,
    guest: !identity.userId,
    userKey: identity.userKey,
    createdAt: iso(dates.created_at),
    lastSeenAt: iso(dates.last_seen_at),
    registeredAt: iso(dates.registered_at),
    updatedAt: iso(dates.updated_at),
    firstSeenIp: dates.first_seen_ip || '',
    lastSeenIp: dates.last_seen_ip || '',
    registrationIp: dates.registration_ip || '',
    lastLoginAt: iso(dates.last_login_at),
    lastLoginIp: dates.last_login_ip || '',
    loginCount: Number(dates.login_count || 0),
    activeSessionCount: Number(dates.active_session_count || 0),
    activeCreatorTokenCount: Number(dates.active_creator_token_count || 0),
    adminNote: dates.admin_note || '',
    tags: Array.isArray(dates.tags) ? dates.tags : [],
    banReason: dates.ban_reason || '',
    bannedAt: iso(dates.banned_at),
    bannedUntil: iso(dates.banned_until),
    adminPermissions: normalizePlayerAdminCapabilities(dates.admin_permissions),
    creatorAccess: dates.creator_access === true,
    creatorPermissions: normalizeCreatorCapabilities(dates.creator_permissions),
  };
}

async function expireTemporaryBans(database: Pool) {
  await database.query(`
    UPDATE ${table('users')}
    SET status = 'active', ban_reason = '', banned_at = NULL, banned_until = NULL,
      updated_at = NOW()
    WHERE status = 'banned' AND banned_until IS NOT NULL AND banned_until <= NOW()
  `);
}

function identityBanHash(kind: 'ip' | 'device', value: string) {
  if (kind === 'device') return value.toLowerCase();
  return createHmac('sha256', identitySecret()).update(value.trim().toLowerCase()).digest('hex');
}

async function activeIdentityBan(database: Pool, kind: 'ip' | 'device', value: string) {
  if (!value) return null;
  const result = await database.query<{ id: string; reason: string; banned_until: Date | null }>(`
    SELECT id::text, reason, banned_until FROM ${table('identity_bans')}
    WHERE kind = $1 AND value_hash = $2 AND revoked_at IS NULL
      AND (banned_until IS NULL OR banned_until > NOW())
    LIMIT 1
  `, [kind, identityBanHash(kind, value)]);
  return result.rows[0] || null;
}

async function assertRequestSourceAllowed(database: Pool, req: NextApiRequest, res: NextApiResponse, migrateDevice = false) {
  const token = ensureDeviceToken(req, res, migrateDevice);
  const [ipBan, deviceBan] = await Promise.all([
    activeIdentityBan(database, 'ip', requestIp(req)),
    activeIdentityBan(database, 'device', tokenHash(token)),
  ]);
  if (ipBan) throw new PlayerBannedError(ipBan.reason, ipBan.banned_until, 'ip');
  if (deviceBan) throw new PlayerBannedError(deviceBan.reason, deviceBan.banned_until, 'device');
  return tokenHash(token);
}

async function findSession(database: Pool, token: string, req: NextApiRequest) {
  if (!token || token.startsWith('guest.')) return null;
  const result = await database.query<IdentityRow & { session_device_hash: string }>(`
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
      u.created_at AS registered_at, u.updated_at, u.registration_ip,
      u.last_login_at, u.last_login_ip, u.login_count, s.device_hash AS session_device_hash
    FROM ${table('sessions')} s
    JOIN ${table('principals')} p ON p.id = s.principal_id
    LEFT JOIN ${table('users')} u ON u.principal_id = p.id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW()
      AND s.created_at > NOW() - INTERVAL '${SESSION_ABSOLUTE_DAYS} days'
  `, [tokenHash(token)]);
  const row = result.rows[0];
  if (!row) return null;
  // A host-only legacy device cookie and a domain-scoped one can coexist, and
  // the cookie parser returns only the first. Accept any candidate that
  // matches the session's binding instead of rejecting a valid login.
  const currentDevices = deviceTokens(req);
  if (!currentDevices.some((device) => sessionDeviceBindingMatches(row.session_device_hash, device))) {
    await database.query(`DELETE FROM ${table('sessions')} WHERE token_hash = $1`, [tokenHash(token)]);
    return null;
  }
  const storedDeviceBan = await activeIdentityBan(database, 'device', row.session_device_hash || '');
  if (storedDeviceBan) {
    await database.query(`DELETE FROM ${table('sessions')} WHERE token_hash = $1`, [tokenHash(token)]);
    throw new PlayerBannedError(storedDeviceBan.reason, storedDeviceBan.banned_until, 'device');
  }
  await database.query(`
    UPDATE ${table('sessions')} SET last_seen_at = NOW(), last_seen_ip = $2,
      expires_at = LEAST(
        NOW() + INTERVAL '${SESSION_IDLE_DAYS} days',
        created_at + INTERVAL '${SESSION_ABSOLUTE_DAYS} days'
      )
    WHERE token_hash = $1
  `, [tokenHash(token), requestIp(req)]);
  await database.query(`UPDATE ${table('principals')} SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1`, [row.subject_id, requestIp(req)]);
  return row;
}

export function isPlayerDatabaseEnabled() {
  return Boolean((process.env.BOX_DATABASE_URL || '').trim());
}

export async function checkPlayerDatabaseReady() {
  identitySecret();
  const database = getPool();
  if (!database) throw new Error('玩家身份服务需要配置 PostgreSQL');
  await initialize();
  await database.query('SELECT 1');
}

export async function getAssignedPlayerAdminCapabilities(subjectId: string) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const result = await database.query<{ admin_permissions: string[] }>(`
    SELECT admin_permissions FROM ${table('users')} WHERE principal_id = $1
  `, [subjectId]);
  return normalizePlayerAdminCapabilities(result.rows[0]?.admin_permissions);
}

export async function resolvePlayerIdentity(req: NextApiRequest, res: NextApiResponse) {
  identitySecret();
  const database = getPool();
  if (!database) throw new Error('玩家身份服务需要配置 PostgreSQL');
  await initialize();
  const currentDeviceHash = await assertRequestSourceAllowed(database, req, res);
  const row = await findSession(database, sessionToken(req), req);
  if (!row?.user_id) throw new Error('AUTH_REQUIRED');
  await database.query(`UPDATE ${table('sessions')} SET device_hash = $2 WHERE token_hash = $1 AND device_hash = ''`, [tokenHash(sessionToken(req)), currentDeviceHash]);
  return { ...rowToIdentity(row), deviceHash: currentDeviceHash };
}

/** Only the authenticated portal issues codes, after validating its session. */
export async function issuePlayerLoginTransfer(req: NextApiRequest, res: NextApiResponse) {
  const { source, challenge } = req.body || {};
  if ((source !== 'play' && source !== 'creator') || typeof challenge !== 'string' || !transferTokenPattern.test(challenge)) {
    throw new Error('登录交换请求无效');
  }
  applicationEndpoint(source, '/api/player-login/callback');
  const identity = await resolvePlayerIdentity(req, res);
  if (identity.status !== 'active') throw new Error('AUTH_REQUIRED');
  const credentials = { session: sessionToken(req), device: deviceToken(req) };
  if (!transferTokenPattern.test(credentials.session) || !transferTokenPattern.test(credentials.device)) throw new Error('AUTH_REQUIRED');
  const database = getPool()!;
  const code = randomBytes(32).toString('base64url');
  await database.query(`DELETE FROM ${table('login_transfers')} WHERE expires_at <= NOW()`);
  await database.query(`
    INSERT INTO ${table('login_transfers')} (code_hash, session_hash, source, challenge, credentials, expires_at)
    VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '60 seconds')
  `, [tokenHash(code), tokenHash(credentials.session), source, challenge, sealTransfer(code, credentials)]);
  return { code };
}

/** Atomic consumption prevents replay; revocation also invalidates outstanding codes. */
export async function redeemPlayerLoginTransfer(req: NextApiRequest, res: NextApiResponse) {
  const { code, source, verifier } = req.body || {};
  if ((source !== 'play' && source !== 'creator') || typeof code !== 'string' || typeof verifier !== 'string' ||
      !transferTokenPattern.test(code) || !transferTokenPattern.test(verifier)) throw new Error('登录交换请求无效');
  applicationEndpoint(source as LoginSource, '/api/player-login/callback');
  await initialize();
  const database = getPool();
  if (!database) throw new Error('玩家账号功能需要配置 PostgreSQL');
  const result = await database.query<{ credentials: string }>(`
    DELETE FROM ${table('login_transfers')}
    WHERE code_hash = $1 AND source = $2 AND challenge = $3 AND expires_at > NOW()
    RETURNING credentials
  `, [tokenHash(code), source, transferChallenge(verifier)]);
  if (!result.rows[0]) throw new Error('登录凭证失效，请重新登录');
  const credentials = openTransfer(code, result.rows[0].credentials);
  const identityRequest = Object.assign(Object.create(req), {
    headers: { ...req.headers, cookie: `${COOKIE_NAME}=${credentials.session}; ${DEVICE_COOKIE_NAME}=${credentials.device}` },
  }) as NextApiRequest;
  const identity = await resolvePlayerIdentity(identityRequest, res);
  if (identity.status !== 'active') throw new Error('AUTH_REQUIRED');
  return credentials;
}

/** Resolves a long-lived CLI token issued from player management. The raw token is never stored. */
export async function resolveCreatorCliTokenIdentity(token: string, req: NextApiRequest) {
  if (!/^bxc_[a-f0-9]{18}_[A-Za-z0-9_-]{32,}$/i.test(token)) throw new Error('AUTH_REQUIRED');
  const database = getPool();
  if (!database) throw new Error('玩家身份服务需要配置 PostgreSQL');
  await initialize();
  const ipBan = await activeIdentityBan(database, 'ip', requestIp(req));
  if (ipBan) throw new PlayerBannedError(ipBan.reason, ipBan.banned_until, 'ip');
  const hash = createHmac('sha256', identitySecret()).update(token).digest('hex');
  const result = await database.query<IdentityRow & { scopes: string[] }>(`
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id,
      u.creator_access, u.creator_permissions, u.role, u.status, t.scopes
    FROM ${table('creator_cli_tokens')} t
    JOIN ${table('principals')} p ON p.id = t.principal_id
    JOIN ${table('users')} u ON u.principal_id = p.id
    WHERE t.token_hash = $1 AND t.revoked_at IS NULL
  `, [hash]);
  const row = result.rows[0];
  if (!row?.user_id || row.status !== 'active') throw new Error('AUTH_REQUIRED');
  // CLI scopes are separate from Creator UI's individual permissions. The
  // product-level creator_access flag remains on the identity as a required
  // gate for every Creator and CLI operation.
  row.creator_cli_permissions = normalizeCreatorCliCapabilities(row.scopes);
  await database.query(`UPDATE ${table('creator_cli_tokens')} SET last_used_at = NOW(), last_used_ip = $2 WHERE token_hash = $1`, [hash, requestIp(req)]);
  return rowToIdentity(row);
}

export function createRuntimeIdentityAssertion(identity: RuntimePlayerIdentity) {
  const { expiresAt: _expiresAt, ...value } = identity;
  const configuredTtl = Number(process.env.BOX_RUNTIME_IDENTITY_TTL_MS);
  const ttlMs =
    Number.isFinite(configuredTtl) && configuredTtl >= 5_000
      ? configuredTtl
      : 5 * 60_000;
  return signRuntimePlayerIdentity(value, identitySecret(), ttlMs);
}

function validateRegistration(username: unknown, displayName: unknown, password: unknown) {
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  const normalizedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  if (!usernamePattern.test(normalizedUsername)) {
    throw new Error('用户名必须以字母开头，只能包含字母、数字和下划线，长度为 3 到 32 位');
  }
  if (!displayNamePattern.test(normalizedDisplayName)) {
    throw new Error('昵称长度必须为 1 到 32 个字符');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new Error('密码长度必须为 10 到 128 个字符');
  }
  return { username: normalizedUsername, displayName: normalizedDisplayName, password };
}

function validateAvatar(avatar: string) {
  if (!avatar) return;
  const embeddedImage = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatar);
  if (embeddedImage) {
    if (avatar.length > 700_000) throw new Error('头像图片过大，请选择 512 KB 以内的图片');
    return;
  }
  if (avatar.length > 2048) throw new Error('头像地址过长');
  try {
    const url = new URL(avatar);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('头像必须是图片上传内容或有效的 HTTPS 地址');
  }
}

function derivePassword(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, value) => error ? reject(error) : resolve(value as Buffer));
  });
}

/**
 * Persist authentication throttling beside identities so limits are shared by
 * every Player Service container and survive a process restart.
 */
export async function consumePersistentAuthRateLimit(
  scope: string,
  rateKey: string,
  maximum: number,
  windowMs: number,
) {
  const database = getPool();
  if (!database) return null;
  await initialize();
  const result = await database.query<{ attempt_count: number; reset_at: Date }>(`
    INSERT INTO ${table('auth_rate_limits')} AS limits
      (scope, rate_key, attempt_count, reset_at)
    VALUES ($1, $2, 1, NOW() + ($3 * INTERVAL '1 millisecond'))
    ON CONFLICT (scope, rate_key) DO UPDATE
    SET attempt_count = CASE
          WHEN limits.reset_at <= NOW() THEN 1
          ELSE limits.attempt_count + 1
        END,
        reset_at = CASE
          WHEN limits.reset_at <= NOW() THEN NOW() + ($3 * INTERVAL '1 millisecond')
          ELSE limits.reset_at
        END
    RETURNING attempt_count, reset_at
  `, [scope, rateKey, windowMs]);
  const entry = result.rows[0];
  if (!entry) return null;
  return {
    allowed: entry.attempt_count <= maximum,
    retryAfterSeconds: entry.attempt_count <= maximum
      ? 0
      : Math.max(1, Math.ceil((entry.reset_at.getTime() - Date.now()) / 1000)),
  };
}

export async function resetPersistentAuthRateLimit(scope: string, rateKey: string) {
  const database = getPool();
  if (!database) return;
  await initialize();
  await database.query(
    `DELETE FROM ${table('auth_rate_limits')} WHERE scope = $1 AND rate_key = $2`,
    [scope, rateKey],
  );
}

export async function releasePersistentAuthRateLimitAttempt(scope: string, rateKey: string) {
  const database = getPool();
  if (!database) return;
  await initialize();
  await database.query(`
    UPDATE ${table('auth_rate_limits')}
    SET attempt_count = GREATEST(attempt_count - 1, 0)
    WHERE scope = $1 AND rate_key = $2 AND reset_at > NOW()
  `, [scope, rateKey]);
  await database.query(`
    DELETE FROM ${table('auth_rate_limits')}
    WHERE scope = $1 AND rate_key = $2
      AND (attempt_count <= 0 OR reset_at <= NOW())
  `, [scope, rateKey]);
}

async function recordAuthFailure(
  database: Pool,
  req: NextApiRequest,
  username: string,
  reason: 'invalid_credentials' | 'banned',
) {
  await database.query(`
    INSERT INTO ${table('auth_failures')} (username, reason, ip_address, user_agent)
    VALUES ($1, $2, $3, $4)
  `, [username.slice(0, 64), reason, requestIp(req), requestUserAgent(req)]);
}

export async function registerPlayer(
  req: NextApiRequest,
  res: NextApiResponse,
  values: { username?: unknown; displayName?: unknown; password?: unknown },
) {
  if (process.env.BOX_PLAYER_REGISTRATION_ENABLED === 'false') {
    throw new Error('服主已关闭玩家注册');
  }
  const database = getPool();
  if (!database) throw new Error('玩家账号功能需要配置 PostgreSQL');
  await initialize();
  const deviceHash = await assertRequestSourceAllowed(database, req, res, true);
  const existing = await findSession(database, sessionToken(req), req);
  if (existing?.user_id) throw new Error('当前已经登录');
  const input = validateRegistration(values.username, values.displayName, values.password);
  const salt = randomBytes(16).toString('base64url');
  const hash = (await derivePassword(input.password, salt)).toString('base64url');
  const subjectUUID = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const ip = requestIp(req);
  const userAgent = requestUserAgent(req);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO ${table('principals')} (id, kind, first_seen_ip, last_seen_ip)
      VALUES ($1, 'user', $2, $2)
    `, [subjectUUID, ip]);
    const result = await client.query<IdentityRow>(`
      WITH inserted AS (
        INSERT INTO ${table('users')}
          (principal_id, username, display_name, password_salt, password_hash,
           registration_ip, last_login_at, last_login_ip, login_count)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), $6, 1)
        RETURNING id, principal_id, username, box_id, user_key, display_name, avatar_hash, avatar_skin_id,
          creator_access, creator_permissions, role, status,
          created_at AS registered_at, updated_at, registration_ip,
          last_login_at, last_login_ip, login_count
      )
      SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
        u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
        u.registered_at, u.updated_at, u.registration_ip,
        u.last_login_at, u.last_login_ip, u.login_count
      FROM ${table('principals')} p JOIN inserted u ON u.principal_id = p.id
    `, [subjectUUID, input.username, input.displayName, salt, hash, ip]);
    await client.query(`
      INSERT INTO ${table('sessions')}
        (token_hash, principal_id, expires_at, created_ip, last_seen_ip, user_agent, device_hash)
      VALUES ($1, $2, NOW() + INTERVAL '${SESSION_IDLE_DAYS} days', $3, $3, $4, $5)
    `, [tokenHash(token), subjectUUID, ip, userAgent, deviceHash]);
    await client.query(`
      INSERT INTO ${table('login_events')} (principal_id, ip_address, user_agent, device_hash)
      VALUES ($1, $2, $3, $4)
    `, [subjectUUID, ip, userAgent, deviceHash]);
    const row = result.rows[0];
    if (!row) throw new Error('账号创建失败');
    await client.query('COMMIT');
    setSessionCookie(req, res, token);
    return toView(rowToIdentity(row), row);
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') throw new Error('用户名已经存在');
    throw error;
  } finally {
    client.release();
  }
}

export async function createManagedPlayer(
  values: {
    username?: unknown;
    displayName?: unknown;
    password?: unknown;
    role?: unknown;
    boxId?: unknown;
    userKey?: unknown;
    tags?: unknown;
    adminNote?: unknown;
    adminPermissions?: unknown;
  },
  context?: AdminActionContext,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const input = validateRegistration(values.username, values.displayName, values.password);
  if (values.role != null && values.role !== 'player') {
    throw new Error('玩家账号不能授予后台角色');
  }
  if (
    values.adminPermissions != null &&
    (!Array.isArray(values.adminPermissions) || values.adminPermissions.length > 0)
  ) {
    throw new Error('玩家账号不能授予后台权限');
  }
  const role: LocalPlayerRole = 'player';
  const adminPermissions: PlayerAdminCapability[] = [];
  if (values.boxId != null && typeof values.boxId !== 'string') throw new Error('神岛 ID 必须是字符串');
  const normalizedBoxId = typeof values.boxId === 'string' ? values.boxId.trim() : '';
  if (normalizedBoxId.length > 64 || /[\u0000-\u001f\u007f]/.test(normalizedBoxId)) {
    throw new Error('神岛 ID 不能超过 64 个字符或包含控制字符');
  }
  if (values.userKey != null && typeof values.userKey !== 'string') throw new Error('用户 Key 必须是字符串');
  const normalizedUserKey = typeof values.userKey === 'string' ? values.userKey.trim() : '';
  if (normalizedUserKey.length > 128 || !/^[\x20-\x7e]*$/.test(normalizedUserKey)) {
    throw new Error('用户 Key 只能包含 128 个以内的可打印 ASCII 字符');
  }
  const tags = Array.isArray(values.tags)
    ? [...new Set(values.tags.map((tag) => String(tag).trim()).filter(Boolean))]
    : [];
  if (tags.length > 20 || tags.some((tag) => tag.length > 32)) {
    throw new Error('最多设置 20 个标签，每个不超过 32 个字符');
  }
  const adminNote = typeof values.adminNote === 'string' ? values.adminNote.trim() : '';
  if (adminNote.length > 2000) throw new Error('服主备注不能超过 2000 个字符');

  const salt = randomBytes(16).toString('base64url');
  const hash = (await derivePassword(input.password, salt)).toString('base64url');
  const subjectUUID = randomUUID();
  const ip = context?.ip || '';
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO ${table('principals')} (id, kind, first_seen_ip, last_seen_ip)
      VALUES ($1, 'user', $2, $2)
    `, [subjectUUID, ip]);
    const result = await client.query<IdentityRow>(`
      WITH inserted AS (
        INSERT INTO ${table('users')}
          (principal_id, username, display_name, password_salt, password_hash,
           role, box_id, user_key, tags, admin_note, registration_ip, admin_permissions, login_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0)
        RETURNING id, principal_id, username, box_id, user_key, display_name, avatar_hash, avatar_skin_id,
          creator_access, creator_permissions, role, status,
          created_at AS registered_at, updated_at, registration_ip,
          last_login_at, last_login_ip, login_count, admin_note, tags,
          ban_reason, banned_at, banned_until, admin_permissions
      )
      SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
        u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
        u.registered_at, u.updated_at, u.registration_ip,
        u.last_login_at, u.last_login_ip, u.login_count, u.admin_note, u.tags,
        u.ban_reason, u.banned_at, u.banned_until, u.admin_permissions,
        0 AS active_session_count
      FROM ${table('principals')} p JOIN inserted u ON u.principal_id = p.id
    `, [
      subjectUUID, input.username, input.displayName, salt, hash, role,
      normalizedBoxId || null, normalizedUserKey || null, tags, adminNote, ip, adminPermissions,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('账号创建失败');
    await audit(client, 'player.create', subjectUUID, {
      username: input.username,
      displayName: input.displayName,
      role,
      boxId: normalizedBoxId,
      userKey: normalizedUserKey,
      tags,
      adminPermissions,
    }, context);
    await client.query('COMMIT');
    return toView(rowToIdentity(row), row);
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new Error('用户名或神岛 ID 已经存在');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function loginPlayer(
  req: NextApiRequest,
  res: NextApiResponse,
  values: { username?: unknown; password?: unknown },
) {
  const database = getPool();
  if (!database) throw new Error('玩家账号功能需要配置 PostgreSQL');
  await initialize();
  await expireTemporaryBans(database);
  const deviceHash = await assertRequestSourceAllowed(database, req, res, true);
  const username = typeof values.username === 'string' ? values.username.trim() : '';
  const password = typeof values.password === 'string' ? values.password : '';
  const result = await database.query<IdentityRow & { password_salt: string; password_hash: string }>(`
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
      u.created_at AS registered_at, u.updated_at, u.registration_ip,
      u.last_login_at, u.last_login_ip, u.login_count, u.ban_reason, u.banned_until,
      u.password_salt, u.password_hash
    FROM ${table('users')} u JOIN ${table('principals')} p ON p.id = u.principal_id
    WHERE LOWER(u.username) = LOWER($1)
  `, [username]);
  const row = result.rows[0];
  // 即使用户名不存在也执行同样成本的 scrypt，降低按响应时间枚举账号的风险。
  const fallbackSalt = 'box-local-missing-user';
  const derived = await derivePassword(password, row?.password_salt || fallbackSalt);
  const expected = row
    ? Buffer.from(row.password_hash, 'base64url')
    : await derivePassword('box-local-invalid-password', fallbackSalt);
  if (!row || derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
    await recordAuthFailure(database, req, username, 'invalid_credentials');
    throw new Error('用户名或密码错误');
  }
  if (row.status === 'banned') {
    await recordAuthFailure(database, req, username, 'banned');
    throw new PlayerBannedError(row.ban_reason || '', row.banned_until);
  }
  const oldToken = sessionToken(req);
  const token = randomBytes(32).toString('base64url');
  const ip = requestIp(req);
  const userAgent = requestUserAgent(req);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent logins for the same account. Without the user-row
    // lock, two simultaneous logins could both remove the old session and
    // then create two new active sessions.
    const locked = await client.query<{ password_salt: string; password_hash: string; status: string; ban_reason: string; banned_until: Date | null }>(`
      SELECT password_salt, password_hash, status, ban_reason, banned_until
      FROM ${table('users')} WHERE principal_id = $1 FOR UPDATE
    `, [row.subject_id]);
    const current = locked.rows[0];
    if (!current) throw new Error('用户名或密码错误');
    if (current.status !== 'active') throw new PlayerBannedError(current.ban_reason || '', current.banned_until);
    // A password change can commit while the initial scrypt verification is running.
    if (!(await verifyLockedLoginPassword(current, row, password, derivePassword))) {
      throw new Error('用户名或密码错误');
    }
    if (oldToken) {
      await client.query(`DELETE FROM ${table('sessions')} WHERE token_hash = $1`, [tokenHash(oldToken)]);
    }
    if (limitsSessionsToSingleDevice(row.role)) {
      await client.query(`DELETE FROM ${table('sessions')} WHERE principal_id = $1`, [row.subject_id]);
    }
    await client.query(`
      INSERT INTO ${table('sessions')}
        (token_hash, principal_id, expires_at, created_ip, last_seen_ip, user_agent, device_hash)
      VALUES ($1, $2, NOW() + INTERVAL '${SESSION_IDLE_DAYS} days', $3, $3, $4, $5)
    `, [tokenHash(token), row.subject_id, ip, userAgent, deviceHash]);
    await client.query(`
      UPDATE ${table('users')} SET last_login_at = NOW(), last_login_ip = $2,
        login_count = login_count + 1, updated_at = NOW()
      WHERE principal_id = $1
    `, [row.subject_id, ip]);
    await client.query(`
      UPDATE ${table('principals')} SET last_seen_at = NOW(), last_seen_ip = $2 WHERE id = $1
    `, [row.subject_id, ip]);
    await client.query(`
      INSERT INTO ${table('login_events')} (principal_id, ip_address, user_agent, device_hash)
      VALUES ($1, $2, $3, $4)
    `, [row.subject_id, ip, userAgent, deviceHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  setSessionCookie(req, res, token);
  return toView(rowToIdentity(row), {
    ...row,
    last_seen_at: new Date(),
    last_seen_ip: ip,
    last_login_at: new Date(),
    last_login_ip: ip,
    login_count: Number(row.login_count || 0) + 1,
  });
}

export async function logoutPlayer(req: NextApiRequest, res: NextApiResponse) {
  const database = getPool();
  const token = sessionToken(req);
  if (database && token) {
    await initialize();
    await database.query(`DELETE FROM ${table('sessions')} WHERE token_hash = $1`, [tokenHash(token)]);
  }
  clearSessionCookie(req, res);
}

export async function currentPlayer(req: NextApiRequest, res: NextApiResponse) {
  let identity: RuntimePlayerIdentity | null = null;
  try {
    identity = await resolvePlayerIdentity(req, res);
  } catch (error) {
    if ((error as Error).message !== 'AUTH_REQUIRED') throw error;
  }
  return {
    player: identity ? toView(identity) : null,
    databaseEnabled: isPlayerDatabaseEnabled(),
    registrationEnabled: process.env.BOX_PLAYER_REGISTRATION_ENABLED !== 'false',
  };
}

export async function changeCurrentPlayerPassword(
  req: NextApiRequest,
  res: NextApiResponse,
  values: { currentPassword?: unknown; newPassword?: unknown },
) {
  const identity = await resolvePlayerIdentity(req, res);
  if (identity.status !== 'active') throw new PlayerSelfServiceError('账号当前不可用', 'PLAYER_BANNED', 403);
  const database = getPool();
  if (!database) throw new Error('PLAYER_DATABASE_NOT_CONFIGURED');
  const result = await changeSelfPassword({
    database, usersTable: table('users'), sessionsTable: table('sessions'),
    subjectId: identity.subjectId, sessionHash: tokenHash(sessionToken(req)),
    absoluteSessionDays: SESSION_ABSOLUTE_DAYS, derivePassword,
    publishRevocation: async (client, revoked) => {
      const eventId = await publishPlayerRevocation(client, identity.subjectId, 'sessions-revoked');
      await audit(client, 'player.password.change', identity.subjectId, { revoked, eventId }, {
        actor: `player:${identity.subjectId}`, actorDisplayName: identity.displayName,
        actorRole: identity.role, ip: requestIp(req), userAgent: requestUserAgent(req),
        deviceHash: tokenHash(deviceToken(req)),
      });
    },
  }, values);
  clearSessionCookie(req, res);
  return result;
}

export async function playerMapLibrary(req: NextApiRequest, res: NextApiResponse) {
  const database = getPool();
  const identity = await resolvePlayerIdentity(req, res);
  if (!database) {
    return { player: toView(identity), entries: [], libraryEnabled: false };
  }
  await initialize();
  const result = await database.query<{ map_id: string; favorite: boolean; last_played_at: Date | null }>(`
    SELECT map_id, favorite, last_played_at FROM ${table('player_map_library')}
    WHERE principal_id = $1 AND (favorite = TRUE OR last_played_at IS NOT NULL)
    ORDER BY last_played_at DESC NULLS LAST
  `, [identity.subjectId]);
  return {
    player: toView(identity),
    entries: result.rows.map((entry) => ({
      mapId: entry.map_id,
      favorite: entry.favorite,
      lastPlayedAt: entry.last_played_at?.toISOString() || null,
    })),
    libraryEnabled: true,
  };
}

export async function updateCurrentPlayerProfile(
  req: NextApiRequest,
  res: NextApiResponse,
  changes: { displayName?: unknown; avatarSkinId?: unknown },
) {
  const identity = await resolvePlayerIdentity(req, res);
  if (!identity.userId) throw new Error('只有已注册账号可以修改资料');
  if (identity.status !== 'active') throw new PlayerSelfServiceError('账号当前不可用', 'PLAYER_BANNED', 403);
  const displayName = typeof changes.displayName === 'string' ? changes.displayName.trim() : undefined;
  const avatarSkinId = typeof changes.avatarSkinId === 'string' ? changes.avatarSkinId.trim() : undefined;
  if (displayName === undefined && avatarSkinId === undefined) throw new Error('没有可更新的资料');
  if (displayName !== undefined && !displayNamePattern.test(displayName)) {
    throw new Error('昵称长度必须为 1 到 32 个字符');
  }
  if (avatarSkinId !== undefined && !builtInSkinIds.has(avatarSkinId)) {
    throw new Error('所选角色皮肤不可用');
  }

  const database = getPool();
  if (!database) throw new Error('PLAYER_DATABASE_NOT_CONFIGURED');
  await initialize();
  const result = await database.query<IdentityRow>(`
    WITH updated AS (
      UPDATE ${table('users')} SET
        display_name = COALESCE($2, display_name),
        avatar_skin_id = COALESCE($3, avatar_skin_id),
        updated_at = NOW()
      WHERE principal_id = $1 AND status = 'active'
      RETURNING id, principal_id, username, box_id, user_key, display_name, avatar_hash, avatar_skin_id,
        creator_access, creator_permissions, role, status,
        created_at AS registered_at, updated_at, registration_ip, last_login_at, last_login_ip, login_count,
        admin_note, tags, ban_reason, banned_at, banned_until, admin_permissions
    )
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
      u.registered_at, u.updated_at, u.registration_ip, u.last_login_at, u.last_login_ip, u.login_count,
      u.admin_note, u.tags, u.ban_reason, u.banned_at, u.banned_until, u.admin_permissions,
      (SELECT COUNT(*) FROM ${table('sessions')} s WHERE s.principal_id = p.id AND s.expires_at > NOW())
        AS active_session_count
    FROM ${table('principals')} p
    JOIN updated u ON u.principal_id = p.id
  `, [identity.subjectId, displayName, avatarSkinId]);
  if (!result.rows[0]) throw new Error('账号资料不存在');
  return toView(rowToIdentity(result.rows[0]), result.rows[0]);
}

export async function updatePlayerMapLibrary(req: NextApiRequest, res: NextApiResponse, mapId: string, changes: { favorite?: boolean; played?: boolean }) {
  const database = getPool();
  if (!database) throw new Error('PLAYER_DATABASE_NOT_CONFIGURED');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(mapId)) throw new Error('地图 ID 无效');
  await initialize();
  const identity = await resolvePlayerIdentity(req, res);
  await database.query(`
    INSERT INTO ${table('player_map_library')} (principal_id, map_id, favorite, last_played_at)
    VALUES ($1, $2, COALESCE($3, FALSE), CASE WHEN $4 THEN NOW() ELSE NULL END)
    ON CONFLICT (principal_id, map_id) DO UPDATE SET
      favorite = COALESCE($3, ${table('player_map_library')}.favorite),
      last_played_at = CASE WHEN $4 THEN NOW() ELSE ${table('player_map_library')}.last_played_at END,
      updated_at = NOW()
  `, [identity.subjectId, mapId, changes.favorite, changes.played === true]);
}

export async function listManagedPlayers(options: ManagedPlayerListOptions = {}): Promise<ManagedPlayerList> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  await expireTemporaryBans(database);
  const normalized = (options.search || '').trim().slice(0, 64);
  const pageSize = Math.max(10, Math.min(100, Math.trunc(options.pageSize || 30)));
  const page = Math.max(1, Math.trunc(options.page || 1));
  const identity = ['all', 'user', 'box', 'banned'].includes(options.identity || '') ? options.identity : 'all';
  const role = ['player', 'moderator', 'admin'].includes(options.role || '') ? options.role : 'all';
  const online = ['online', 'offline'].includes(options.online || '') ? options.online : 'all';
  const orderBy = {
    lastSeen: 'p.last_seen_at DESC',
    registered: 'u.created_at DESC NULLS LAST',
    displayName: 'u.display_name ASC NULLS LAST',
    loginCount: 'u.login_count DESC NULLS LAST',
  }[options.sort || 'lastSeen'] || 'p.last_seen_at DESC';
  const values: unknown[] = [normalized, identity, role, online];
  const where = `
    ($1 = '' OR u.username ILIKE '%' || $1 || '%'
      OR u.box_id ILIKE '%' || $1 || '%'
      OR u.display_name ILIKE '%' || $1 || '%'
      OR u.admin_note ILIKE '%' || $1 || '%'
      OR $1 = ANY(u.tags)
      OR CAST(u.id AS TEXT) = $1 OR CAST(p.id AS TEXT) ILIKE $1 || '%')
    AND (
      $2 = 'all'
      OR ($2 = 'user' AND u.id IS NOT NULL AND NULLIF(BTRIM(u.box_id), '') IS NULL)
      OR ($2 = 'box' AND NULLIF(BTRIM(u.box_id), '') IS NOT NULL)
      OR ($2 = 'banned' AND u.status = 'banned')
    )
    AND ($3 = 'all' OR u.role = $3)
    AND ($4 = 'all' OR ($4 = 'online' AND EXISTS (
      SELECT 1 FROM ${table('sessions')} sx WHERE sx.principal_id = p.id AND sx.expires_at > NOW()
    )) OR ($4 = 'offline' AND NOT EXISTS (
      SELECT 1 FROM ${table('sessions')} sx WHERE sx.principal_id = p.id AND sx.expires_at > NOW()
    )))
  `;
  const countResult = await database.query<{ total: string }>(`
    SELECT COUNT(*) AS total
    FROM ${table('principals')} p
    LEFT JOIN ${table('users')} u ON u.principal_id = p.id
    WHERE ${where}
  `, values);
  const total = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  values.push(pageSize, (safePage - 1) * pageSize);
  const result = await database.query<IdentityRow>(`
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
      u.created_at AS registered_at, u.updated_at, u.registration_ip,
      u.last_login_at, u.last_login_ip, u.login_count, u.admin_note, u.tags,
      u.ban_reason, u.banned_at, u.banned_until, u.admin_permissions,
      (SELECT COUNT(*) FROM ${table('sessions')} s
        WHERE s.principal_id = p.id AND s.expires_at > NOW()) AS active_session_count,
      (SELECT COUNT(*) FROM ${table('creator_cli_tokens')} ct
        WHERE ct.principal_id = p.id AND ct.revoked_at IS NULL) AS active_creator_token_count
    FROM ${table('principals')} p
    LEFT JOIN ${table('users')} u ON u.principal_id = p.id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT $5 OFFSET $6
  `, values);
  return {
    players: result.rows.map((row) => toView(rowToIdentity(row), row)),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

export async function listIdentityBans(options: IdentityBanListOptions = {}): Promise<IdentityBanList> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const search = (options.search || '').trim().slice(0, 128);
  const kind = options.kind === 'ip' || options.kind === 'device' ? options.kind : 'all';
  const pageSize = Math.max(10, Math.min(100, Math.trunc(options.pageSize || 30)));
  const page = Math.max(1, Math.trunc(options.page || 1));
  const values: unknown[] = [search, kind];
  const where = `
    b.revoked_at IS NULL
    AND (b.banned_until IS NULL OR b.banned_until > NOW())
    AND ($1 = '' OR b.display_value ILIKE '%' || $1 || '%' OR b.reason ILIKE '%' || $1 || '%'
      OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
    AND ($2 = 'all' OR b.kind = $2)
  `;
  const count = await database.query<{ total: string }>(`
    SELECT COUNT(*) AS total
    FROM ${table('identity_bans')} b
    LEFT JOIN ${table('users')} u ON u.principal_id = b.source_subject_id
    WHERE ${where}
  `, values);
  const total = Number(count.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  values.push(pageSize, (safePage - 1) * pageSize);
  const result = await database.query<{
    id: string; kind: 'ip' | 'device'; display_value: string; reason: string;
    banned_at: string | Date; banned_until: string | Date | null; source_subject_id: string | null;
    source_display_name: string | null; source_username: string | null;
  }>(`
    SELECT b.id::text, b.kind, b.display_value, b.reason, b.banned_at, b.banned_until,
      REPLACE(b.source_subject_id::text, '-', '') AS source_subject_id,
      u.display_name AS source_display_name, u.username AS source_username
    FROM ${table('identity_bans')} b
    LEFT JOIN ${table('users')} u ON u.principal_id = b.source_subject_id
    WHERE ${where}
    ORDER BY b.banned_at DESC
    LIMIT $3 OFFSET $4
  `, values);
  return {
    bans: result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      displayValue: row.display_value,
      reason: row.reason,
      bannedAt: new Date(row.banned_at).toISOString(),
      bannedUntil: row.banned_until ? new Date(row.banned_until).toISOString() : undefined,
      sourceSubjectId: row.source_subject_id || undefined,
      sourceDisplayName: row.source_display_name || row.source_username || '未知玩家',
      sourceUsername: row.source_username || '',
    })),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

function csvCell(value: unknown) {
  const raw = value == null ? '' : String(value);
  // Spreadsheet programs may execute cells beginning with these characters.
  // Player-controlled names, tags and notes must remain inert in exports.
  const text = typeof value === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeManagedPlayersCsv(rows: PlayerAccountView[]) {
  const columns = [
    '用户ID', '身份ID', 'userKey', '用户名', '神岛ID', '昵称', '角色', '状态', '标签',
    '注册时间', '注册IP', '最后登录时间', '最后登录IP', '登录次数',
    '最后在线时间', '最后在线IP', '有效会话', '封禁原因', '封禁截止', '服主备注',
  ];
  const lines = rows.map((player) => [
    player.userId, player.subjectId, player.userKey, player.username, player.boxId,
    player.displayName, player.role, player.status, player.tags.join('|'),
    player.registeredAt || player.createdAt || '', player.registrationIp || player.firstSeenIp,
    player.lastLoginAt || '', player.lastLoginIp, player.loginCount,
    player.lastSeenAt || '', player.lastSeenIp, player.activeSessionCount,
    player.banReason, player.bannedUntil || '', player.adminNote,
  ].map(csvCell).join(','));
  return `\uFEFF${columns.map(csvCell).join(',')}\r\n${lines.join('\r\n')}\r\n`;
}

export async function exportManagedPlayersCsv(options: ManagedPlayerListOptions = {}) {
  const rows: PlayerAccountView[] = [];
  const maximum = 10_000;
  let page = 1;
  let total = 0;
  do {
    const result = await listManagedPlayers({ ...options, page, pageSize: 100 });
    total = result.total;
    rows.push(...result.players);
    page += 1;
  } while (rows.length < Math.min(total, maximum));
  return {
    csv: serializeManagedPlayersCsv(rows.slice(0, maximum)),
    exported: Math.min(rows.length, maximum),
    total,
    truncated: total > maximum,
  };
}

export async function getPlayerAdminOverview(): Promise<PlayerAdminOverview> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  await expireTemporaryBans(database);
  const [totalsResult, loginResult, auditResult, failedIpResult, sharedIpResult, securityCountResult] = await Promise.all([
    database.query<{
      identities: string; users: string; guests: string; banned: string;
      active_sessions: string; active_last_24_hours: string; new_last_7_days: string;
      logins_last_24_hours: string; failed_logins_last_24_hours: string;
      unique_login_ips_last_7_days: string;
      moderators: string; admins: string;
    }>(`
      SELECT
        COUNT(*) AS identities,
        COUNT(u.id) AS users,
        COUNT(*) FILTER (WHERE u.id IS NULL) AS guests,
        COUNT(*) FILTER (WHERE u.status = 'banned') AS banned,
        (SELECT COUNT(*) FROM ${table('sessions')} WHERE expires_at > NOW()) AS active_sessions,
        COUNT(*) FILTER (WHERE p.last_seen_at >= NOW() - INTERVAL '24 hours') AS active_last_24_hours,
        COUNT(*) FILTER (WHERE p.created_at >= NOW() - INTERVAL '7 days') AS new_last_7_days,
        (SELECT COUNT(*) FROM ${table('login_events')} WHERE created_at >= NOW() - INTERVAL '24 hours') AS logins_last_24_hours,
        (SELECT COUNT(*) FROM ${table('auth_failures')} WHERE created_at >= NOW() - INTERVAL '24 hours') AS failed_logins_last_24_hours,
        (SELECT COUNT(DISTINCT NULLIF(ip_address, '')) FROM ${table('login_events')} WHERE created_at >= NOW() - INTERVAL '7 days') AS unique_login_ips_last_7_days,
        COUNT(*) FILTER (WHERE u.role = 'moderator') AS moderators,
        COUNT(*) FILTER (WHERE u.role = 'admin') AS admins
      FROM ${table('principals')} p
      LEFT JOIN ${table('users')} u ON u.principal_id = p.id
    `),
    database.query<{
      subject_id: string; display_name: string | null; username: string | null;
      ip_address: string; user_agent: string; created_at: string | Date;
    }>(`
      SELECT e.principal_id AS subject_id, u.display_name, u.username,
        e.ip_address, e.user_agent, e.created_at
      FROM ${table('login_events')} e
      LEFT JOIN ${table('users')} u ON u.principal_id = e.principal_id
      ORDER BY e.created_at DESC
      LIMIT 30
    `),
    database.query<{
      id: string | number; action: string; subject_id: string | null;
      details: Record<string, unknown>; created_at: string | Date;
    }>(`
      SELECT id, action, subject_id, details, created_at
      FROM ${table('audit_logs')}
      ORDER BY created_at DESC
      LIMIT 30
    `),
    database.query<{
      ip_address: string; attempts: string; last_attempt_at: string | Date;
    }>(`
      SELECT ip_address, COUNT(*) AS attempts, MAX(created_at) AS last_attempt_at
      FROM ${table('auth_failures')}
      WHERE created_at >= NOW() - INTERVAL '24 hours' AND ip_address <> ''
      GROUP BY ip_address
      ORDER BY COUNT(*) DESC, MAX(created_at) DESC
      LIMIT 10
    `),
    database.query<{
      ip_address: string; accounts: string; last_seen_at: string | Date;
    }>(`
      SELECT ip_address, COUNT(DISTINCT principal_id) AS accounts,
        MAX(created_at) AS last_seen_at
      FROM ${table('login_events')}
      WHERE created_at >= NOW() - INTERVAL '30 days' AND ip_address <> ''
      GROUP BY ip_address
      HAVING COUNT(DISTINCT principal_id) > 1
      ORDER BY COUNT(DISTINCT principal_id) DESC, MAX(created_at) DESC
      LIMIT 10
    `),
    database.query<{ temporary_bans: string; expired_sessions: string }>(`
      SELECT
        (SELECT COUNT(*) FROM ${table('users')}
          WHERE status = 'banned' AND banned_until > NOW()
            AND banned_until <= NOW() + INTERVAL '24 hours') AS temporary_bans,
        (SELECT COUNT(*) FROM ${table('sessions')}
          WHERE expires_at <= NOW()) AS expired_sessions
    `),
  ]);
  const totals = totalsResult.rows[0];
  return {
    totals: {
      identities: Number(totals?.identities || 0),
      users: Number(totals?.users || 0),
      guests: Number(totals?.guests || 0),
      banned: Number(totals?.banned || 0),
      activeSessions: Number(totals?.active_sessions || 0),
      activeLast24Hours: Number(totals?.active_last_24_hours || 0),
      newLast7Days: Number(totals?.new_last_7_days || 0),
      loginsLast24Hours: Number(totals?.logins_last_24_hours || 0),
      failedLoginsLast24Hours: Number(totals?.failed_logins_last_24_hours || 0),
      uniqueLoginIpsLast7Days: Number(totals?.unique_login_ips_last_7_days || 0),
      moderators: Number(totals?.moderators || 0),
      admins: Number(totals?.admins || 0),
    },
    recentLogins: loginResult.rows.map((event) => ({
      subjectId: normalizeSubjectId(event.subject_id),
      displayName: event.display_name || `玩家${normalizeSubjectId(event.subject_id).slice(-6)}`,
      username: event.username || '',
      ip: event.ip_address || '',
      userAgent: event.user_agent || '',
      createdAt: new Date(event.created_at).toISOString(),
    })),
    recentAudits: auditResult.rows.map((event) => ({
      id: String(event.id),
      action: event.action,
      subjectId: event.subject_id ? normalizeSubjectId(event.subject_id) : '',
      details: event.details || {},
      createdAt: new Date(event.created_at).toISOString(),
    })),
    security: {
      topFailedIps: failedIpResult.rows.map((entry) => ({
        ip: entry.ip_address,
        attempts: Number(entry.attempts || 0),
        lastAttemptAt: new Date(entry.last_attempt_at).toISOString(),
      })),
      sharedLoginIps: sharedIpResult.rows.map((entry) => ({
        ip: entry.ip_address,
        accounts: Number(entry.accounts || 0),
        lastSeenAt: new Date(entry.last_seen_at).toISOString(),
      })),
      temporaryBansEndingSoon: Number(securityCountResult.rows[0]?.temporary_bans || 0),
      expiredSessions: Number(securityCountResult.rows[0]?.expired_sessions || 0),
    },
  };
}

export async function getManagedPlayerDetails(subjectId: string): Promise<ManagedPlayerDetails> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  await expireTemporaryBans(database);
  const result = await database.query<IdentityRow>(`
    SELECT p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip,
      u.id AS user_id, u.username, u.box_id, u.user_key, u.display_name, u.avatar_hash, u.avatar_skin_id, u.creator_access, u.creator_permissions, u.role, u.status,
      u.created_at AS registered_at, u.updated_at, u.registration_ip,
      u.last_login_at, u.last_login_ip, u.login_count, u.admin_note, u.tags,
      u.ban_reason, u.banned_at, u.banned_until, u.admin_permissions,
      (SELECT COUNT(*) FROM ${table('sessions')} s
        WHERE s.principal_id = p.id AND s.expires_at > NOW()) AS active_session_count
    FROM ${table('principals')} p
    LEFT JOIN ${table('users')} u ON u.principal_id = p.id
    WHERE p.id = $1
  `, [subjectId]);
  const row = result.rows[0];
  if (!row) throw new PlayerAdminRequestError('玩家不存在', 404);
  const [sessions, cliTokens, history, adminHistory, relatedAccounts, identityBans] = await Promise.all([
    database.query<{
      session_id: string; created_at: string | Date; last_seen_at: string | Date;
      expires_at: string | Date; created_ip: string; last_seen_ip: string; user_agent: string;
      device_hash: string;
    }>(`
      SELECT LEFT(token_hash, 16) AS session_id, created_at, last_seen_at, expires_at,
        created_ip, last_seen_ip, user_agent, device_hash
      FROM ${table('sessions')}
      WHERE principal_id = $1 AND expires_at > NOW()
      ORDER BY last_seen_at DESC
      LIMIT 20
    `, [subjectId]),
    listCreatorCliTokens(subjectId),
    database.query<{
      created_at: string | Date; ip_address: string; user_agent: string; device_hash: string;
    }>(`
      SELECT created_at, ip_address, user_agent, device_hash
      FROM ${table('login_events')}
      WHERE principal_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [subjectId]),
    database.query<{
      id: string | number; action: string; actor: string;
      details: Record<string, unknown>; created_at: string | Date;
    }>(`
      SELECT id, action, actor, details, created_at
      FROM ${table('audit_logs')}
      WHERE subject_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [subjectId]),
    database.query<{
      subject_id: string; display_name: string; username: string;
      shared_ip: string; last_seen_at: string | Date;
    }>(`
      WITH target_ips AS (
        SELECT DISTINCT ip_address
        FROM ${table('login_events')}
        WHERE principal_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
          AND ip_address <> ''
      )
      SELECT e.principal_id AS subject_id, u.display_name, u.username,
        e.ip_address AS shared_ip, MAX(e.created_at) AS last_seen_at
      FROM ${table('login_events')} e
      JOIN target_ips target ON target.ip_address = e.ip_address
      JOIN ${table('users')} u ON u.principal_id = e.principal_id
      WHERE e.principal_id <> $1 AND e.created_at >= NOW() - INTERVAL '90 days'
      GROUP BY e.principal_id, u.display_name, u.username, e.ip_address
      ORDER BY MAX(e.created_at) DESC
      LIMIT 30
    `, [subjectId]),
    database.query<{
      id: string; kind: 'ip' | 'device'; display_value: string; reason: string;
      banned_at: string | Date; banned_until: string | Date | null;
    }>(`
      SELECT b.id::text, b.kind, b.display_value, b.reason, b.banned_at, b.banned_until
      FROM ${table('identity_bans')} b
      WHERE b.revoked_at IS NULL AND (b.banned_until IS NULL OR b.banned_until > NOW())
        AND b.source_subject_id = $1
      ORDER BY b.banned_at DESC
    `, [subjectId]),
  ]);
  return {
    player: toView(rowToIdentity(row), row),
    cliTokens,
    sessions: sessions.rows.map((session) => ({
      sessionId: session.session_id,
      createdAt: new Date(session.created_at).toISOString(),
      lastSeenAt: new Date(session.last_seen_at).toISOString(),
      expiresAt: new Date(session.expires_at).toISOString(),
      createdIp: session.created_ip || '',
      lastSeenIp: session.last_seen_ip || '',
      userAgent: session.user_agent || '',
      deviceHash: session.device_hash || '',
      deviceId: session.device_hash ? session.device_hash.slice(0, 16) : '',
    })),
    loginHistory: history.rows.map((event) => ({
      createdAt: new Date(event.created_at).toISOString(),
      ip: event.ip_address || '',
      userAgent: event.user_agent || '',
      deviceHash: event.device_hash || '',
      deviceId: event.device_hash ? event.device_hash.slice(0, 16) : '',
    })),
    adminHistory: adminHistory.rows.map((event) => ({
      id: String(event.id),
      action: event.action,
      actor: event.actor,
      actorDisplayName: String(event.details?.actorDisplayName || event.actor),
      details: event.details || {},
      createdAt: new Date(event.created_at).toISOString(),
    })),
    relatedAccounts: relatedAccounts.rows.map((account) => ({
      subjectId: normalizeSubjectId(account.subject_id),
      displayName: account.display_name || '',
      username: account.username || '',
      sharedIp: account.shared_ip || '',
      lastSeenAt: new Date(account.last_seen_at).toISOString(),
    })),
    identityBans: identityBans.rows.map((ban) => ({
      id: ban.id,
      kind: ban.kind,
      displayValue: ban.display_value,
      reason: ban.reason,
      bannedAt: new Date(ban.banned_at).toISOString(),
      bannedUntil: ban.banned_until ? new Date(ban.banned_until).toISOString() : undefined,
    })),
  };
}

export type CreatorCliTokenView = {
  id: string;
  name: string;
  scopes: CreatorCliCapability[];
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
  lastUsedIp: string;
  revokedAt?: string;
};

export async function listCreatorCliTokens(subjectId: string): Promise<CreatorCliTokenView[]> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const result = await database.query<{
    id: string; name: string; scopes: string[]; created_at: string | Date; created_by: string;
    last_used_at: string | Date | null; last_used_ip: string; revoked_at: string | Date | null;
  }>(`SELECT id, name, scopes, created_at, created_by, last_used_at, last_used_ip, revoked_at
      FROM ${table('creator_cli_tokens')} WHERE principal_id = $1 ORDER BY created_at DESC`, [subjectId]);
  return result.rows.map((row) => ({
    id: row.id, name: row.name, scopes: normalizeCreatorCliCapabilities(row.scopes),
    createdAt: new Date(row.created_at).toISOString(), createdBy: row.created_by || '',
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
    lastUsedIp: row.last_used_ip || '',
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
  }));
}

export async function createCreatorCliToken(
  subjectId: string,
  values: { name: string; scopes: unknown },
  context?: AdminActionContext,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const name = values.name.trim();
  if (!name || name.length > 80) throw new Error('Token 名称无效');
  const requested = normalizeCreatorCliCapabilities(values.scopes);
  const target = await database.query<{ status: string; creator_access: boolean }>(
    `SELECT status, creator_access FROM ${table('users')} WHERE principal_id = $1`, [subjectId],
  );
  const user = target.rows[0];
  if (!user || user.status !== 'active') throw new Error('目标玩家账号不可用于 CLI Token');
  if (!user.creator_access) throw new Error('目标玩家尚未允许进入创作端，CLI Token 不可用');
  const id = randomBytes(9).toString('hex');
  const token = `bxc_${id}_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHmac('sha256', identitySecret()).update(token).digest('hex');
  await database.query(`INSERT INTO ${table('creator_cli_tokens')}
      (id, principal_id, name, token_hash, scopes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, subjectId, name, tokenHash, requested, context?.actor || 'server-owner']);
  await audit(database, 'creator.cli-token.create', subjectId, { tokenId: id, name, scopes: requested }, context);
  return { id, name, scopes: requested, token };
}

export async function revokeCreatorCliToken(subjectId: string, tokenId: string, context?: AdminActionContext) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const result = await database.query(`UPDATE ${table('creator_cli_tokens')}
      SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL RETURNING name`,
    [tokenId, subjectId, context?.actor || 'server-owner']);
  if (!result.rowCount) throw new Error('CLI Token 不存在或已撤销');
  await audit(database, 'creator.cli-token.revoke', subjectId, { tokenId, name: result.rows[0].name }, context);
  return { revoked: true };
}

export async function updateCreatorCliToken(
  subjectId: string,
  tokenId: string,
  scopes: unknown,
  context?: AdminActionContext,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const requested = normalizeCreatorCliCapabilities(scopes);
  const target = await database.query<{ status: string; creator_access: boolean }>(
    `SELECT status, creator_access FROM ${table('users')} WHERE principal_id = $1`, [subjectId],
  );
  const user = target.rows[0];
  if (!user || user.status !== 'active') throw new Error('目标玩家账号不可用于 CLI Token');
  if (!user.creator_access) throw new Error('目标玩家尚未允许进入创作端，CLI Token 不可用');
  const result = await database.query<{ name: string }>(`UPDATE ${table('creator_cli_tokens')}
      SET scopes = $3 WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL RETURNING name`,
    [tokenId, subjectId, requested]);
  if (!result.rowCount) throw new Error('CLI Token 不存在或已撤销');
  await audit(database, 'creator.cli-token.update', subjectId, { tokenId, name: result.rows[0].name, scopes: requested }, context);
  return { id: tokenId, name: result.rows[0].name, scopes: requested };
}

async function audit(
  client: Pool | PoolClient,
  action: string,
  subjectId: string | null,
  details: unknown,
  context?: AdminActionContext,
) {
  await client.query(`
    INSERT INTO ${table('audit_logs')} (actor, action, subject_id, details)
    VALUES ($1, $2, $3, $4::jsonb)
  `, [context?.actor || 'server-owner', action, subjectId, JSON.stringify({
    ...(details && typeof details === 'object' ? details : {}),
    actorDisplayName: context?.actorDisplayName || '服主密钥',
    actorRole: context?.actorRole || 'owner',
    actorIp: context?.ip || '',
    actorUserAgent: context?.userAgent || '',
  })]);
}

export async function cleanupExpiredPlayerSessions(context?: AdminActionContext) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`DELETE FROM ${table('sessions')} WHERE expires_at <= NOW()`);
    if (result.rowCount) {
      await audit(client, 'system.sessions.cleanup', null, {
        deleted: result.rowCount,
      }, context);
    }
    await client.query('COMMIT');
    return { deleted: result.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPlayerAdminActivity(options: {
  kind?: 'all' | 'login' | 'admin';
  search?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PlayerAdminActivity> {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const kind = ['login', 'admin'].includes(options.kind || '') ? options.kind : 'all';
  const search = (options.search || '').trim().slice(0, 64);
  const pageSize = Math.max(10, Math.min(100, Math.trunc(options.pageSize || 30)));
  const page = Math.max(1, Math.trunc(options.page || 1));
  const eventQuery = `
    WITH events AS (
      SELECT 'login'::text AS kind, 'login:' || e.id::text AS id,
        'login.success'::text AS action, 'player:' || REPLACE(e.principal_id::text, '-', '') AS actor,
        COALESCE(u.display_name, '') AS actor_display_name,
        e.principal_id AS subject_id, COALESCE(u.display_name, '') AS display_name,
        COALESCE(u.username, '') AS username, e.ip_address AS ip,
        e.user_agent, '{}'::jsonb AS details, e.created_at
      FROM ${table('login_events')} e
      LEFT JOIN ${table('users')} u ON u.principal_id = e.principal_id
      UNION ALL
      SELECT 'login'::text AS kind, 'failure:' || f.id::text AS id,
        'login.failed'::text AS action, 'anonymous'::text AS actor,
        f.username AS actor_display_name, NULL::uuid AS subject_id,
        f.username AS display_name, f.username, f.ip_address AS ip,
        f.user_agent, jsonb_build_object('reason', f.reason) AS details, f.created_at
      FROM ${table('auth_failures')} f
      UNION ALL
      SELECT 'admin'::text AS kind, 'audit:' || a.id::text AS id,
        a.action, a.actor, COALESCE(a.details->>'actorDisplayName', a.actor) AS actor_display_name,
        a.subject_id, COALESCE(u.display_name, a.details->>'displayName', '') AS display_name,
        COALESCE(u.username, a.details->>'username', '') AS username,
        COALESCE(a.details->>'actorIp', '') AS ip,
        COALESCE(a.details->>'actorUserAgent', '') AS user_agent,
        a.details, a.created_at
      FROM ${table('audit_logs')} a
      LEFT JOIN ${table('users')} u ON u.principal_id = a.subject_id
      UNION ALL
      SELECT 'login'::text AS kind, 'admin-login:' || al.id::text AS id,
        CASE WHEN al.success THEN 'admin.login.success' ELSE 'admin.login.failed' END AS action,
        'admin:' || COALESCE(al.admin_id::text, al.username) AS actor,
        al.username AS actor_display_name, NULL::uuid AS subject_id,
        al.username AS display_name, al.username, al.ip_address AS ip,
        al.user_agent, jsonb_build_object('reason', al.reason) AS details, al.created_at
      FROM ${table('admin_login_events')} al
      UNION ALL
      SELECT 'admin'::text AS kind, 'admin-audit:' || aa.id::text AS id,
        aa.action, aa.actor_id AS actor,
        COALESCE(aa.details->>'actorDisplayName', aa.details->>'actorUsername', aa.actor_id)
          AS actor_display_name,
        NULL::uuid AS subject_id,
        COALESCE(aa.details->>'targetName', aa.details->>'mapName', aa.details->>'displayName', aa.details->>'name', aa.details->>'username', aa.target_id)
          AS display_name,
        COALESCE(aa.details->>'username', aa.target_id) AS username,
        aa.ip_address AS ip, COALESCE(aa.details->>'actorUserAgent', '') AS user_agent,
        aa.details, aa.created_at
      FROM ${table('admin_audit_events')} aa
    )
  `;
  const where = `
    ($1 = 'all' OR kind = $1)
    AND ($2 = '' OR action ILIKE '%' || $2 || '%'
      OR actor ILIKE '%' || $2 || '%' OR actor_display_name ILIKE '%' || $2 || '%'
      OR display_name ILIKE '%' || $2 || '%' OR username ILIKE '%' || $2 || '%'
      OR COALESCE(subject_id::text, '') ILIKE $2 || '%' OR ip ILIKE $2 || '%'
      OR details->>'mapId' ILIKE '%' || $2 || '%' OR details->>'mapName' ILIKE '%' || $2 || '%'
      OR details->>'targetId' ILIKE '%' || $2 || '%' OR details->>'requestId' ILIKE '%' || $2 || '%'
      OR details->>'reason' ILIKE '%' || $2 || '%')
  `;
  const count = await database.query<{ total: string }>(`${eventQuery} SELECT COUNT(*) AS total FROM events WHERE ${where}`, [kind, search]);
  const total = Number(count.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const result = await database.query<{
    id: string; kind: 'login' | 'admin'; action: string; actor: string;
    actor_display_name: string; subject_id: string | null; display_name: string;
    username: string; ip: string; user_agent: string; details: Record<string, unknown>;
    created_at: string | Date;
  }>(`${eventQuery}
    SELECT * FROM events WHERE ${where}
    ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
  `, [kind, search, pageSize, (safePage - 1) * pageSize]);
  return {
    events: result.rows.map((event) => ({
      id: event.id,
      kind: event.kind,
      action: event.action,
      actor: event.actor,
      actorDisplayName: event.actor_display_name || event.actor,
      subjectId: event.subject_id ? normalizeSubjectId(event.subject_id) : '',
      displayName: event.display_name || '',
      username: event.username || '',
      ip: event.ip || '',
      userAgent: event.user_agent || '',
      details: event.details || {},
      createdAt: new Date(event.created_at).toISOString(),
    })),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}

async function publishPlayerRevocation(
  client: Pool | PoolClient,
  subjectId: string,
  reason: 'sessions-revoked' | 'banned' | 'deleted' | 'user-key-updated',
) {
  const result = await client.query<{ id: string }>(`
    INSERT INTO ${table('player_revocations')} (subject_id, reason)
    VALUES ($1, $2)
    RETURNING id::text
  `, [subjectId, reason]);
  return result.rows[0]?.id || '';
}

export async function listPlayerRevocations(
  after: number,
  since: Date,
  limit = 500,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const result = await database.query<{
    id: string;
    subject_id: string;
    reason: string;
    created_at: string | Date;
  }>(`
    SELECT id::text, REPLACE(subject_id::text, '-', '') AS subject_id,
      reason, created_at
    FROM ${table('player_revocations')}
    WHERE id > $1 AND created_at >= $2
    ORDER BY id ASC
    LIMIT $3
  `, [after, since, Math.max(1, Math.min(500, limit))]);
  const events = result.rows.map((row) => ({
    id: row.id,
    subjectId: row.subject_id,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  return {
    cursor: events.length ? events[events.length - 1].id : String(after),
    events,
  };
}

export async function createIdentityBan(
  subjectId: string,
  values: { kind?: unknown; value?: unknown; reason?: unknown; bannedUntil?: unknown },
  context?: AdminActionContext,
  transaction?: PoolClient,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const kind = values.kind === 'ip' || values.kind === 'device' ? values.kind : null;
  if (!kind) throw new Error('封禁类型无效');
  const value = typeof values.value === 'string' ? values.value.trim() : '';
  if (kind === 'ip' && (!value || value.length > 128)) throw new Error('IP 地址无效');
  if (kind === 'device' && !/^[0-9a-f]{64}$/i.test(value)) throw new Error('设备标识无效');
  if (kind === 'device' && context?.deviceHash && context.deviceHash === value.toLowerCase()) {
    throw new Error('不能封禁当前管理会话使用的设备');
  }
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
  if (reason.length > 500) throw new Error('封禁原因不能超过 500 个字符');
  const bannedUntil = values.bannedUntil === '' || values.bannedUntil == null
    ? null
    : new Date(String(values.bannedUntil));
  if (bannedUntil && (Number.isNaN(bannedUntil.getTime()) || bannedUntil <= new Date())) {
    throw new Error('封禁截止时间必须晚于当前时间');
  }
  const valueHash = identityBanHash(kind, value);
  const displayValue = kind === 'device' ? value.slice(0, 16) : value;
  const client = transaction || await database.connect();
  try {
    if (!transaction) await client.query('BEGIN');
    await client.query(`
      UPDATE ${table('identity_bans')} SET revoked_at = NOW(), revoked_by = 'system-expired'
      WHERE kind = $1 AND value_hash = $2 AND revoked_at IS NULL
        AND banned_until IS NOT NULL AND banned_until <= NOW()
    `, [kind, valueHash]);
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO ${table('identity_bans')}
        (kind, value_hash, display_value, reason, banned_until, created_by, source_subject_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id::text
    `, [kind, valueHash, displayValue, reason, bannedUntil, context?.actor || 'server-owner', subjectId]);
    const affected = await client.query<{ principal_id: string }>(kind === 'ip' ? `
      DELETE FROM ${table('sessions')}
      WHERE created_ip = $1 OR last_seen_ip = $1
      RETURNING principal_id
    ` : `
      DELETE FROM ${table('sessions')}
      WHERE device_hash = $1
      RETURNING principal_id
    `, [kind === 'ip' ? value : value.toLowerCase()]);
    const subjects = [...new Set(affected.rows.map((row) => row.principal_id))];
    for (const affectedSubjectId of subjects) {
      await publishPlayerRevocation(client, affectedSubjectId, 'sessions-revoked');
    }
    await audit(client, `identity.${kind}.ban`, subjectId, {
      banId: inserted.rows[0]?.id || '', displayValue, reason,
      bannedUntil: bannedUntil?.toISOString() || null,
      affectedSessions: affected.rowCount || 0,
      affectedPlayers: subjects.length,
    }, context);
    if (!transaction) await client.query('COMMIT');
    return {
      id: inserted.rows[0]?.id || '', kind, displayValue, reason,
      bannedUntil: bannedUntil?.toISOString(),
      affectedSessions: affected.rowCount || 0,
      affectedPlayers: subjects.length,
    };
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') throw new Error('该 IP 或设备已经处于封禁状态');
    throw error;
  } finally {
    if (!transaction) client.release();
  }
}

async function lockLinkedScriptIdentityBans(client: PoolClient, banId: string) {
  const exists = (await client.query('SELECT to_regclass($1) AS relation', [table('script_moderation_bans')])).rows[0]?.relation;
  if (!exists) return false;
  // Script unban also locks its record before touching the identity ban.
  await client.query(`SELECT id FROM ${table('script_moderation_bans')}
    WHERE scope='server' AND kind IN ('ip','device') AND reference_id=$1
    AND revoked_at IS NULL ORDER BY id FOR UPDATE`, [banId]);
  return true;
}

async function syncLinkedScriptIdentityBan(client: PoolClient, banId: string) {
  await client.query(`UPDATE ${table('script_moderation_bans')} b
    SET revoked_at=i.revoked_at FROM ${table('identity_bans')} i
    WHERE b.scope='server' AND b.kind=i.kind AND b.reference_id=i.id::text
    AND i.id::text=$1 AND i.revoked_at IS NOT NULL AND b.revoked_at IS NULL`, [banId]);
}

export async function revokeIdentityBan(subjectId: string, banId: unknown, context?: AdminActionContext, transaction?: PoolClient) {
  if (!/^\d+$/.test(String(banId || ''))) throw new Error('封禁记录无效');
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = transaction || await database.connect();
  try {
    if (!transaction) await client.query('BEGIN');
    const linkedScripts = await lockLinkedScriptIdentityBans(client, String(banId));
    const result = await client.query<{ kind: string; display_value: string }>(`
      UPDATE ${table('identity_bans')}
      SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1 AND source_subject_id = $2 AND revoked_at IS NULL
      RETURNING kind, display_value
    `, [String(banId), subjectId, context?.actor || 'server-owner']);
    if (!result.rowCount) throw new Error('封禁记录不存在或已经解除');
    if (linkedScripts) await syncLinkedScriptIdentityBan(client, String(banId));
    await audit(client, `identity.${result.rows[0].kind}.unban`, subjectId, {
      banId: String(banId), displayValue: result.rows[0].display_value,
    }, context);
    if (!transaction) await client.query('COMMIT');
    return { revoked: true };
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!transaction) client.release();
  }
}

export async function revokeIdentityBanGlobally(banId: unknown, context?: AdminActionContext) {
  if (!/^\d+$/.test(String(banId || ''))) throw new Error('封禁记录无效');
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const linkedScripts = await lockLinkedScriptIdentityBans(client, String(banId));
    const result = await client.query<{ kind: 'ip' | 'device'; display_value: string; source_subject_id: string | null }>(`
      UPDATE ${table('identity_bans')}
      SET revoked_at = NOW(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING kind, display_value, REPLACE(source_subject_id::text, '-', '') AS source_subject_id
    `, [String(banId), context?.actor || 'server-owner']);
    if (!result.rowCount) throw new Error('封禁记录不存在、已经解除或已过期');
    if (linkedScripts) await syncLinkedScriptIdentityBan(client, String(banId));
    const ban = result.rows[0];
    await audit(client, `identity.${ban.kind}.unban`, ban.source_subject_id || null, {
      banId: String(banId), displayValue: ban.display_value, source: 'identity-ban-list',
    }, context);
    await client.query('COMMIT');
    return { revoked: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateManagedPlayer(
  subjectId: string,
  changes: {
    displayName?: unknown; role?: unknown; status?: unknown; avatar?: unknown;
    adminNote?: unknown; tags?: unknown; banReason?: unknown; bannedUntil?: unknown;
  boxId?: unknown; userKey?: unknown; adminPermissions?: unknown; creatorAccess?: unknown; creatorPermissions?: unknown;
  },
  context?: AdminActionContext,
  transaction?: PoolClient,
) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const displayName = typeof changes.displayName === 'string' ? changes.displayName.trim() : undefined;
  const avatar = typeof changes.avatar === 'string' ? changes.avatar.trim() : undefined;
  const role = changes.role as LocalPlayerRole | undefined;
  const status = changes.status as LocalPlayerStatus | undefined;
  const adminNote = typeof changes.adminNote === 'string' ? changes.adminNote.trim() : undefined;
  const tags = Array.isArray(changes.tags)
    ? [...new Set(changes.tags.map((tag) => String(tag).trim()).filter(Boolean))]
    : undefined;
  const banReason = typeof changes.banReason === 'string' ? changes.banReason.trim() : undefined;
  const bannedUntil = changes.bannedUntil === '' || changes.bannedUntil == null
    ? null
    : new Date(String(changes.bannedUntil));
  const hasBoxId = Object.prototype.hasOwnProperty.call(changes, 'boxId');
  const hasUserKey = Object.prototype.hasOwnProperty.call(changes, 'userKey');
  const hasAdminPermissions = Object.prototype.hasOwnProperty.call(changes, 'adminPermissions');
  const hasCreatorAccess = Object.prototype.hasOwnProperty.call(changes, 'creatorAccess');
  const hasCreatorPermissions = Object.prototype.hasOwnProperty.call(changes, 'creatorPermissions');
  if (role !== undefined || hasAdminPermissions) {
    throw new Error('玩家角色与后台管理权限已经分离，不能在玩家资料中修改');
  }
  if (hasAdminPermissions && !Array.isArray(changes.adminPermissions)) {
    throw new Error('管理员权限必须是数组');
  }
  const adminPermissions = hasAdminPermissions
    ? normalizePlayerAdminCapabilities(changes.adminPermissions)
    : undefined;
  if (hasCreatorAccess && typeof changes.creatorAccess !== 'boolean') {
    throw new Error('创作者授权必须是布尔值');
  }
  if (hasCreatorPermissions && !Array.isArray(changes.creatorPermissions)) {
    throw new Error('创作者权限必须是数组');
  }
  const creatorAccess = hasCreatorAccess ? changes.creatorAccess === true : undefined;
  const creatorPermissions = hasCreatorPermissions
    ? normalizeCreatorCapabilities(changes.creatorPermissions)
    : undefined;
  if (hasBoxId && typeof changes.boxId !== 'string') throw new Error('神岛 ID 必须是字符串');
  const normalizedBoxId = hasBoxId ? String(changes.boxId).trim() : undefined;
  const boxId = normalizedBoxId === '' ? null : normalizedBoxId;
  if (hasUserKey && typeof changes.userKey !== 'string') throw new Error('用户 Key 必须是字符串');
  const normalizedUserKey = hasUserKey ? String(changes.userKey).trim() : undefined;
  const userKey = normalizedUserKey === '' ? null : normalizedUserKey;
  if (displayName !== undefined && !displayNamePattern.test(displayName)) throw new Error('昵称长度必须为 1 到 32 个字符');
  if (avatar !== undefined) validateAvatar(avatar);
  if (role !== undefined && !['player', 'moderator', 'admin'].includes(role)) throw new Error('角色无效');
  if (status !== undefined && !['active', 'banned'].includes(status)) throw new Error('状态无效');
  if (adminNote !== undefined && adminNote.length > 2000) throw new Error('服主备注不能超过 2000 个字符');
  if (tags && (tags.length > 20 || tags.some((tag) => tag.length > 32))) throw new Error('最多设置 20 个标签，每个不超过 32 个字符');
  if (banReason !== undefined && banReason.length > 500) throw new Error('封禁原因不能超过 500 个字符');
  if (bannedUntil && Number.isNaN(bannedUntil.getTime())) throw new Error('封禁截止时间无效');
  if (status === 'banned' && bannedUntil && bannedUntil <= new Date()) throw new Error('封禁截止时间必须晚于当前时间');
  if (boxId !== undefined && boxId !== null && (boxId.length > 64 || /[\u0000-\u001f\u007f]/.test(boxId))) {
    throw new Error('神岛 ID 不能超过 64 个字符或包含控制字符');
  }
  if (userKey !== undefined && userKey !== null && (userKey.length > 128 || !/^[\x20-\x7e]*$/.test(userKey))) {
    throw new Error('用户 Key 只能包含 128 个以内的可打印 ASCII 字符');
  }
  const client = transaction || await database.connect();
  try {
    if (!transaction) await client.query('BEGIN');
    const previous = await client.query<{
      display_name: string;
      avatar_hash: string | null;
      status: LocalPlayerStatus;
      admin_note: string;
      tags: string[];
      ban_reason: string;
      banned_until: string | Date | null;
      box_id: string | null;
      user_key: string | null;
      creator_access: boolean;
      creator_permissions: string[];
    }>(`
      SELECT display_name, avatar_hash, status, admin_note, tags, ban_reason, banned_until, box_id, user_key,
        creator_access, creator_permissions
      FROM ${table('users')} WHERE principal_id = $1 FOR UPDATE
    `, [subjectId]);
    const previousPlayer = previous.rows[0];
    if (!previousPlayer) throw new Error('只能修改已经注册的玩家');
    const previousBannedUntil = previousPlayer.banned_until
      ? new Date(previousPlayer.banned_until).toISOString()
      : '';
    const nextBannedUntil = status === 'active'
      ? ''
      : status === 'banned'
        ? bannedUntil?.toISOString() || ''
        : previousBannedUntil;
    const nextBanReason = status === 'active'
      ? ''
      : banReason === undefined
        ? previousPlayer.ban_reason
        : banReason;
    const changed = (displayName !== undefined && displayName !== previousPlayer.display_name)
      || (avatar !== undefined && avatar !== (previousPlayer.avatar_hash || ''))
      || (status !== undefined && status !== previousPlayer.status)
      || (adminNote !== undefined && adminNote !== previousPlayer.admin_note)
      || (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(previousPlayer.tags || []))
      || nextBanReason !== previousPlayer.ban_reason
      || nextBannedUntil !== previousBannedUntil
      || (hasBoxId && boxId !== previousPlayer.box_id)
      || (hasUserKey && userKey !== previousPlayer.user_key)
      || (hasCreatorAccess && creatorAccess !== previousPlayer.creator_access)
      || (hasCreatorPermissions && JSON.stringify(creatorPermissions) !== JSON.stringify(normalizeCreatorCapabilities(previousPlayer.creator_permissions)));
    if (changed) {
      const result = await client.query<IdentityRow>(`
      UPDATE ${table('users')} SET
        display_name = COALESCE($2, display_name),
        avatar_hash = COALESCE($3, avatar_hash),
        role = COALESCE($4, role),
        status = COALESCE($5, status),
        admin_note = COALESCE($6, admin_note),
        tags = COALESCE($7, tags),
        ban_reason = CASE WHEN $5 = 'active' THEN '' ELSE COALESCE($8, ban_reason) END,
        banned_at = CASE WHEN $5 = 'banned' AND status <> 'banned' THEN NOW() WHEN $5 = 'active' THEN NULL ELSE banned_at END,
        banned_until = CASE WHEN $5 = 'active' THEN NULL WHEN $5 = 'banned' THEN $9 ELSE banned_until END,
        box_id = CASE WHEN $10 THEN $11 ELSE box_id END,
        user_key = CASE WHEN $12 THEN $13 ELSE user_key END,
        creator_access = CASE WHEN $14 THEN $15 ELSE creator_access END,
        creator_permissions = CASE WHEN $16 THEN $17 ELSE creator_permissions END,
        admin_permissions = CASE
          WHEN COALESCE($4, role) <> 'moderator' THEN '{}'::text[]
          WHEN $18 THEN $19
          ELSE admin_permissions
        END,
        updated_at = NOW()
      WHERE principal_id = $1
      RETURNING principal_id AS subject_id
      `, [
        subjectId, displayName, avatar, role, status, adminNote, tags, banReason,
        bannedUntil, hasBoxId, boxId, hasUserKey, userKey, hasCreatorAccess, creatorAccess,
        hasCreatorPermissions, creatorPermissions || [], hasAdminPermissions, adminPermissions || [],
      ]);
      if (!result.rows[0]) throw new Error('只能修改已经注册的玩家');
      if (status === 'banned' && previousPlayer.status !== 'banned') {
        await client.query(`DELETE FROM ${table('sessions')} WHERE principal_id = $1`, [subjectId]);
        await publishPlayerRevocation(client, subjectId, 'banned');
      }
      // Runtime identity is signed when a map session is created. A changed
      // user key cannot be applied to an already-running session, so revoke
      // the player's sessions and let the client reconnect with the new key.
      if (hasUserKey && userKey !== previousPlayer.user_key) {
        await client.query(`DELETE FROM ${table('sessions')} WHERE principal_id = $1`, [subjectId]);
        await publishPlayerRevocation(client, subjectId, 'user-key-updated');
      }
      const auditAction = hasUserKey && Object.keys(changes).every((key) => key === 'userKey')
        ? 'player.user-key.update'
        : hasBoxId && Object.keys(changes).every((key) => key === 'boxId')
        ? 'player.box-id.update'
        : 'player.update';
      await audit(client, auditAction, subjectId, {
        displayName, avatar, role, status, adminNote, adminPermissions, creatorAccess, creatorPermissions,
        tags, banReason, bannedUntil: bannedUntil?.toISOString() || null,
        ...(hasBoxId ? { previousBoxId: previousPlayer.box_id || '', boxId: boxId || '' } : {}),
        ...(hasUserKey ? { previousUserKey: previousPlayer.user_key || '', userKey: userKey || '' } : {}),
        outcome: 'success',
      }, context);
    }
    if (!transaction) await client.query('COMMIT');
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK');
    if ((error as { code?: string; constraint?: string }).code === '23505' &&
      ['local_users_box_id', 'local_users_user_key'].includes((error as { constraint?: string }).constraint || '')) {
      throw new Error((error as { constraint?: string }).constraint === 'local_users_user_key'
        ? '该用户 Key 已绑定到其他玩家'
        : '该神岛 ID 已绑定到其他玩家');
    }
    throw error;
  } finally {
    if (!transaction) client.release();
  }
  if (transaction) {
    // Read our own write on the caller's connection. Opening another connection
    // here can observe stale state or deadlock against our uncommitted user lock.
    const result = await transaction.query<IdentityRow>(`
      SELECT u.*, u.id AS user_id, u.created_at AS registered_at,
        p.id AS subject_id, p.created_at, p.last_seen_at, p.first_seen_ip, p.last_seen_ip
      FROM ${table('users')} u JOIN ${table('principals')} p ON p.id=u.principal_id
      WHERE p.id=$1
    `,[subjectId]);
    return toView(rowToIdentity(result.rows[0]),result.rows[0]);
  }
  return (await getManagedPlayerDetails(subjectId)).player;
}

export async function revokeManagedPlayerSession(
  subjectId: string,
  sessionId: string,
  context?: AdminActionContext,
) {
  if (!/^[0-9a-f]{16}$/i.test(sessionId)) throw new Error('会话标识无效');
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      DELETE FROM ${table('sessions')}
      WHERE principal_id = $1 AND LEFT(token_hash, 16) = LOWER($2)
    `, [subjectId, sessionId]);
    if (!result.rowCount) throw new Error('会话不存在或已经失效');
    const eventId = await publishPlayerRevocation(client, subjectId, 'sessions-revoked');
    await audit(client, 'player.session.revoke', subjectId, { sessionId, eventId }, context);
    await client.query('COMMIT');
    return { revoked: 1, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeManagedPlayerSessions(subjectId: string, context?: AdminActionContext) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM ${table('principals')} WHERE id = $1`, [subjectId]);
    if (!exists.rowCount) throw new Error('玩家不存在');
    const result = await client.query(`DELETE FROM ${table('sessions')} WHERE principal_id = $1`, [subjectId]);
    const eventId = await publishPlayerRevocation(client, subjectId, 'sessions-revoked');
    await audit(client, 'player.sessions.revoke', subjectId, {
      revoked: result.rowCount || 0,
      eventId,
    }, context);
    await client.query('COMMIT');
    return { revoked: result.rowCount || 0, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetManagedPlayerPassword(
  subjectId: string,
  password: unknown,
  context?: AdminActionContext,
) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new Error('新密码长度必须为 10 到 128 个字符');
  }
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const salt = randomBytes(16).toString('base64url');
  const hash = (await derivePassword(password, salt)).toString('base64url');
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(`
      UPDATE ${table('users')}
      SET password_salt = $2, password_hash = $3, updated_at = NOW()
      WHERE principal_id = $1
    `, [subjectId, salt, hash]);
    if (!updated.rowCount) throw new Error('只能重置已经注册的玩家密码');
    const sessions = await client.query(`DELETE FROM ${table('sessions')} WHERE principal_id = $1`, [subjectId]);
    const eventId = await publishPlayerRevocation(client, subjectId, 'sessions-revoked');
    await audit(client, 'player.password.reset', subjectId, {
      revoked: sessions.rowCount || 0,
      eventId,
    }, context);
    await client.query('COMMIT');
    return { reset: true, revoked: sessions.rowCount || 0, eventId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type ManagedPlayerBatchAction =
  | 'revoke-sessions'
  | 'ban'
  | 'unban'
  | 'add-tag'
  | 'remove-tag';

export async function batchManagePlayers(
  subjectIds: unknown,
  action: unknown,
  payload: { reason?: unknown; bannedUntil?: unknown; tag?: unknown } = {},
  context?: AdminActionContext,
) {
  if (!Array.isArray(subjectIds)) throw new Error('请选择要操作的玩家');
  const ids = [...new Set(subjectIds.map(String))].filter((id) => /^[0-9a-f]{32}$/i.test(id));
  if (!ids.length) throw new Error('请选择有效的玩家');
  if (ids.length > 100) throw new Error('单次最多管理 100 位玩家');
  if (!['revoke-sessions', 'ban', 'unban', 'add-tag', 'remove-tag'].includes(String(action))) {
    throw new Error('不支持的批量操作');
  }
  const batchAction = action as ManagedPlayerBatchAction;
  const tag = typeof payload.tag === 'string' ? payload.tag.trim() : '';
  if ((batchAction === 'add-tag' || batchAction === 'remove-tag') && (!tag || tag.length > 32)) {
    throw new Error('标签长度必须为 1 到 32 个字符');
  }
  const results: Array<{ subjectId: string; ok: boolean; message?: string }> = [];
  for (const subjectId of ids) {
    try {
      if (context?.subjectId && context.subjectId === subjectId
        && ['revoke-sessions', 'ban'].includes(batchAction)) {
        throw new Error('不能对当前正在操作的管理员账号执行此操作');
      }
      if (context?.actorRole === 'moderator') {
        const target = await getManagedPlayerDetails(subjectId);
        if (target.player.role !== 'player') throw new Error('管理员不能管理其他管理角色');
      }
      if (batchAction === 'revoke-sessions') {
        await revokeManagedPlayerSessions(subjectId, context);
      } else if (batchAction === 'ban') {
        await updateManagedPlayer(subjectId, {
          status: 'banned',
          banReason: payload.reason,
          bannedUntil: payload.bannedUntil,
        }, context);
      } else if (batchAction === 'unban') {
        await updateManagedPlayer(subjectId, { status: 'active' }, context);
      } else {
        const details = await getManagedPlayerDetails(subjectId);
        const tags = batchAction === 'add-tag'
          ? [...new Set([...details.player.tags, tag])]
          : details.player.tags.filter((value) => value !== tag);
        await updateManagedPlayer(subjectId, { tags }, context);
      }
      results.push({ subjectId, ok: true });
    } catch (error) {
      results.push({ subjectId, ok: false, message: (error as Error).message });
    }
  }
  return {
    action: batchAction,
    requested: ids.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export async function deleteManagedPlayer(subjectId: string, context?: AdminActionContext) {
  const database = getPool();
  if (!database) throw new Error('玩家管理需要配置 PostgreSQL');
  await initialize();
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{
      username: string | null;
      display_name: string | null;
      user_id: string | number | null;
    }>(`
      SELECT u.username, u.display_name, u.id AS user_id
      FROM ${table('principals')} p
      LEFT JOIN ${table('users')} u ON u.principal_id = p.id
      WHERE p.id = $1
      FOR UPDATE OF p
    `, [subjectId]);
    if (!target.rowCount) throw new Error('玩家不存在');
    const result = await client.query(`
      DELETE FROM ${table('principals')} WHERE id = $1 RETURNING id
    `, [subjectId]);
    if (!result.rowCount) throw new Error('玩家不存在');
    await publishPlayerRevocation(client, subjectId, 'deleted');
    await audit(client, 'player.delete', subjectId, {
      username: target.rows[0]?.username || '',
      displayName: target.rows[0]?.display_name || '',
      userId: target.rows[0]?.user_id == null ? '' : String(target.rows[0].user_id),
      outcome: 'success',
    }, context);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
