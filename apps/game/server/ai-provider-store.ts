import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { Pool } from 'pg';

import { getPool } from './local-player-identity';
import {
  decryptAiProviderKey,
  encryptAiProviderKey,
} from './ai-provider-secrets';

export type AiProviderProtocol = 'chat-completions' | 'responses' | 'anthropic-messages';
export type AiAutonomyMode = 'review' | 'autonomous';
export type AiProviderCapabilities = {
  tools: boolean;
  vision: boolean;
  json: boolean;
};
export type AiProviderModel = {
  id: string;
  name?: string;
};
export type AiProviderPublic = {
  id: string;
  owner: 'user' | 'admin';
  name: string;
  protocol: AiProviderProtocol;
  baseUrl: string;
  keyHint: string;
  defaultModel: string;
  models: AiProviderModel[];
  headers: Record<string, string>;
  capabilities: AiProviderCapabilities;
  enabled: boolean;
  isDefault: boolean;
  lastTestedAt: string | null;
  lastTestStatus: string;
};
export type AiProviderSecret = AiProviderPublic & { apiKey: string };
export type AiProviderInput = {
  name?: string;
  protocol?: AiProviderProtocol;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  models?: Array<string | { id: string; name?: string }>;
  headers?: Record<string, string>;
  capabilities?: Partial<AiProviderCapabilities>;
  enabled?: boolean;
};
export type AiPreference = {
  workflow: string;
  providerId: string | null;
  model: string;
  autonomy: AiAutonomyMode;
  updatedAt?: string;
};

export class AiProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

const PROTOCOLS: readonly AiProviderProtocol[] = ['chat-completions', 'responses', 'anthropic-messages'];
const AUTONOMY_MODES: readonly AiAutonomyMode[] = ['review', 'autonomous'];
const WORKFLOW_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const BLOCKED_HEADERS = new Set([
  'authorization', 'x-api-key', 'cookie', 'host', 'content-type',
  'content-length', 'anthropic-version', 'accept-encoding',
]);

let initialized: Promise<void> | null = null;

function identitySchema() {
  const value = process.env.BOX_IDENTITY_DATABASE_SCHEMA || 'box_identity';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error('BOX_IDENTITY_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier');
  }
  return value;
}

function table(name: string) {
  return `"${identitySchema().replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
}

function database(): Pool {
  const pool = getPool();
  if (!pool) throw new AiProviderError('PLAYER_DATABASE_NOT_CONFIGURED', '玩家账号数据库未配置', 503);
  return pool;
}

async function ensureStore() {
  if (!initialized) {    initialized = (async () => {
      const db = database();
      await db.query(`CREATE TABLE IF NOT EXISTS ${table('ai_execution_policy')} (id integer PRIMARY KEY CHECK (id = 1), enabled boolean NOT NULL DEFAULT true, blocked_users jsonb NOT NULL DEFAULT '[]', blocked_maps jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT NOW())`);
      await db.query(`INSERT INTO ${table('ai_execution_policy')} (id) VALUES (1) ON CONFLICT DO NOTHING`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${table('ai_providers')} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id integer REFERENCES ${table('users')}(id) ON DELETE CASCADE,
          is_default boolean NOT NULL DEFAULT false,
          name text NOT NULL,
          protocol text NOT NULL,
          base_url text NOT NULL,
          api_key_cipher bytea NOT NULL,
          api_key_iv bytea NOT NULL,
          api_key_tag bytea NOT NULL,
          key_version integer NOT NULL DEFAULT 1,
          key_hint text NOT NULL DEFAULT '',
          default_model text NOT NULL DEFAULT '',
          models jsonb NOT NULL DEFAULT '[]'::jsonb,
          headers jsonb NOT NULL DEFAULT '{}'::jsonb,
          capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
          enabled boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT NOW(),
          updated_at timestamptz NOT NULL DEFAULT NOW(),
          last_tested_at timestamptz,
          last_test_status text NOT NULL DEFAULT ''
        )
      `);
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_user_name
        ON ${table('ai_providers')} (user_id, name) WHERE user_id IS NOT NULL
      `);
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_admin_name
        ON ${table('ai_providers')} (name) WHERE user_id IS NULL
      `);
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_one_default
        ON ${table('ai_providers')} (is_default) WHERE is_default = true
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS ${table('ai_preferences')} (
          user_id integer NOT NULL REFERENCES ${table('users')}(id) ON DELETE CASCADE,
          workflow text NOT NULL,
          provider_id uuid REFERENCES ${table('ai_providers')}(id) ON DELETE SET NULL,
          model text NOT NULL DEFAULT '',
          autonomy text NOT NULL DEFAULT 'review',
          updated_at timestamptz NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, workflow)
        )
      `);
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  await initialized;
}

export async function initializeAiProviderStore() {
  await ensureStore();
}

function numericUserId(value: string | number) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AiProviderError('INVALID_USER', '无效的用户身份', 401);
  }
  return id;
}

function text(value: unknown, field: string, max: number, pattern?: RegExp) {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result) || (pattern && !pattern.test(result))) {
    throw new AiProviderError('INVALID_PROVIDER_INPUT', `${field} 不合法`);
  }
  return result;
}

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max);
}

function normalizeProtocol(value: unknown): AiProviderProtocol {
  const result = String(value ?? 'chat-completions');
  if (!PROTOCOLS.includes(result as AiProviderProtocol)) {
    throw new AiProviderError('INVALID_PROVIDER_PROTOCOL', '不支持的协议类型');
  }
  return result as AiProviderProtocol;
}

function normalizeModels(value: unknown): AiProviderModel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new AiProviderError('INVALID_PROVIDER_INPUT', 'models 必须是最多 200 项的数组');
  }
  const seen = new Set<string>();
  const models: AiProviderModel[] = [];
  for (const item of value) {
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.id : '';
    const modelId = text(id, 'model id', 200);
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const name = typeof item === 'object' && item && item.name ? String(item.name).slice(0, 200) : undefined;
    models.push(name ? { id: modelId, name } : { id: modelId });
  }
  return models;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiProviderError('INVALID_PROVIDER_INPUT', 'headers 必须是对象');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new AiProviderError('INVALID_PROVIDER_INPUT', 'headers 最多 32 项');
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name) || BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new AiProviderError('INVALID_PROVIDER_INPUT', `不允许自定义请求头 ${name}`);
    }
    const normalized = String(headerValue ?? '');
    if (normalized.length > 2048 || /[\r\n\u0000]/.test(normalized)) {
      throw new AiProviderError('INVALID_PROVIDER_INPUT', 'Invalid request header value');
    }
    headers[name] = normalized;
  }
  return headers;
}

function normalizeCapabilities(value: unknown): AiProviderCapabilities {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    tools: source.tools !== false,
    vision: source.vision === true,
    json: source.json === true,
  };
}

function normalizeAutonomy(value: unknown): AiAutonomyMode {
  const result = String(value ?? 'review');
  if (!AUTONOMY_MODES.includes(result as AiAutonomyMode)) {
    throw new AiProviderError('INVALID_AUTONOMY', '自主度必须是 review 或 autonomous');
  }
  return result as AiAutonomyMode;
}

function allowPrivateProviders() {
  return process.env.NODE_ENV !== 'production' && process.env.AI_PROVIDER_ALLOW_PRIVATE === 'true';
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
    if (value.startsWith('::ffff:')) {
      const suffix = value.slice(7);
      if (isIP(suffix) === 4) return isPrivateAddress(suffix);
      const words = suffix.split(':');
      if (words.length === 2 && words.every(word => /^[0-9a-f]{1,4}$/.test(word))) {
        const n = parseInt(words[0], 16) * 65536 + parseInt(words[1], 16);
        return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
      }
      return true;
    }
    return false;
  }
  return true;
}

export async function assertSafeProviderUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiProviderError('INVALID_PROVIDER_URL', 'Base URL 不是合法地址');
  }
  const allowPrivate = allowPrivateProviders();
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new AiProviderError('INVALID_PROVIDER_URL', 'Base URL 必须使用 https');
  }
  if (url.username || url.password) {
    throw new AiProviderError('INVALID_PROVIDER_URL', 'Base URL 不能包含用户名或密码');
  }
  if (url.search || url.hash) throw new AiProviderError('INVALID_PROVIDER_URL', 'Base URL must not contain query parameters or fragments');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new AiProviderError('UNSAFE_PROVIDER_URL', '不允许访问本地或内部地址');
    }
    let records;
    try {
      records = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new AiProviderError('PROVIDER_HOST_UNRESOLVED', '无法解析 Base URL 的域名');
    }
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
      throw new AiProviderError('UNSAFE_PROVIDER_URL', '不允许访问私有网络地址');
    }
  }
  return url.toString().replace(/\/$/, '');
}

function rowPublic(row: any): AiProviderPublic {
  return {
    id: String(row.id),
    owner: row.user_id === null || row.user_id === undefined ? 'admin' : 'user',
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    keyHint: row.key_hint || '',
    defaultModel: row.default_model || '',
    models: Array.isArray(row.models) ? row.models : [],
    headers: row.headers && typeof row.headers === 'object' ? row.headers : {},
    capabilities: normalizeCapabilities(row.capabilities),
    enabled: row.enabled !== false,
    isDefault: row.is_default === true,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at).toISOString() : null,
    lastTestStatus: row.last_test_status || '',
  };
}

function rowSecret(row: any): AiProviderSecret {
  return {
    ...rowPublic(row),
    apiKey: decryptAiProviderKey({
      key_version: row.key_version,
      ciphertext: row.api_key_cipher,
      iv: row.api_key_iv,
      tag: row.api_key_tag,
    }),
  };
}

async function readRow(db: Pool, userId: number, id: string, includeAdmin: boolean) {
  const result = await db.query(
    `SELECT * FROM ${table('ai_providers')}
     WHERE id = $1 AND (user_id = $2 ${includeAdmin ? 'OR (user_id IS NULL AND is_default = true)' : ''})`,
    [id, userId],
  );
  return result.rows[0] || null;
}

export async function listAiProviders(userId: string | number): Promise<AiProviderPublic[]> {
  await ensureStore();
  const result = await database().query(
    `SELECT * FROM ${table('ai_providers')}
     WHERE user_id = $1 OR (user_id IS NULL AND is_default = true)
     ORDER BY (user_id IS NULL), name`,
    [numericUserId(userId)],
  );
  return result.rows.map(rowPublic);
}

export async function createAiProvider(userId: string | number, input: AiProviderInput): Promise<AiProviderPublic> {
  await ensureStore();
  const id = numericUserId(userId);
  const name = text(input.name, '渠道名', 64);
  const protocol = normalizeProtocol(input.protocol);
  const baseUrl = await assertSafeProviderUrl(text(input.baseUrl, 'Base URL', 2048));
  const apiKey = String(input.apiKey || '');
  if (!apiKey) throw new AiProviderError('PROVIDER_KEY_REQUIRED', 'API Key 必填');
  const secret = encryptAiProviderKey(apiKey);
  const models = normalizeModels(input.models);
  const headers = normalizeHeaders(input.headers);
  const capabilities = normalizeCapabilities(input.capabilities);
  try {
    const result = await database().query(
      `INSERT INTO ${table('ai_providers')}
       (user_id, name, protocol, base_url, api_key_cipher, api_key_iv, api_key_tag, key_version, key_hint,
        default_model, models, headers, capabilities, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
       RETURNING *`,
      [id, name, protocol, baseUrl, secret.ciphertext, secret.iv, secret.tag, secret.version, secret.hint,
        optionalText(input.defaultModel, '默认模型', 200) || '', JSON.stringify(models), JSON.stringify(headers),
        JSON.stringify(capabilities), input.enabled !== false],
    );
    return rowPublic(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AiProviderError('AI_PROVIDER_NAME_EXISTS', '同名渠道已存在');
    }
    throw error;
  }
}

export async function updateAiProvider(userId: string | number, id: string, input: AiProviderInput): Promise<AiProviderPublic> {
  await ensureStore();
  const uid = numericUserId(userId);
  const current = await readRow(database(), uid, id, false);
  if (!current) throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '渠道不存在', 404);
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (input.name !== undefined) push('name', text(input.name, '渠道名', 64));
  if (input.protocol !== undefined) push('protocol', normalizeProtocol(input.protocol));
  if (input.baseUrl !== undefined) push('base_url', await assertSafeProviderUrl(text(input.baseUrl, 'Base URL', 2048)));
  if (input.defaultModel !== undefined) push('default_model', optionalText(input.defaultModel, '默认模型', 200) || '');
  if (input.models !== undefined) push('models', JSON.stringify(normalizeModels(input.models)));
  if (input.headers !== undefined) push('headers', JSON.stringify(normalizeHeaders(input.headers)));
  if (input.capabilities !== undefined) push('capabilities', JSON.stringify(normalizeCapabilities(input.capabilities)));
  if (input.enabled !== undefined) push('enabled', Boolean(input.enabled));
  if (input.apiKey !== undefined && String(input.apiKey).trim()) {
    const secret = encryptAiProviderKey(String(input.apiKey));
    push('api_key_cipher', secret.ciphertext);
    push('api_key_iv', secret.iv);
    push('api_key_tag', secret.tag);
    push('key_version', secret.version);
    push('key_hint', secret.hint);
  }
  if (!sets.length) return rowPublic(current);
  values.push(id, uid);
  try {
    const result = await database().query(
      `UPDATE ${table('ai_providers')} SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING *`,
      values,
    );
    if (!result.rows[0]) throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '渠道不存在', 404);
    return rowPublic(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AiProviderError('AI_PROVIDER_NAME_EXISTS', '同名渠道已存在');
    }
    throw error;
  }
}

export async function deleteAiProvider(userId: string | number, id: string) {
  await ensureStore();
  const result = await database().query(
    `DELETE FROM ${table('ai_providers')} WHERE id = $1 AND user_id = $2`,
    [id, numericUserId(userId)],
  );
  return (result.rowCount || 0) > 0;
}

export async function getAiProviderSecret(userId: string | number, id: string): Promise<AiProviderSecret> {
  await ensureStore();
  const row = await readRow(database(), numericUserId(userId), id, true);
  if (!row || row.enabled === false) {
    throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '渠道不存在或已停用', 404);
  }
  await assertSafeProviderUrl(row.base_url);
  return rowSecret(row);
}

export async function resolveAiProvider(userId: string | number, providerId?: string): Promise<AiProviderSecret> {
  await ensureStore();
  const uid = numericUserId(userId);
  if (providerId) {
    return getAiProviderSecret(uid, providerId);
  }
  const own = await database().query(
    `SELECT * FROM ${table('ai_providers')} WHERE user_id = $1 AND enabled = true ORDER BY created_at LIMIT 1`,
    [uid],
  );
  if (own.rows[0]) { await assertSafeProviderUrl(own.rows[0].base_url); return rowSecret(own.rows[0]); }
  const fallback = await database().query(
    `SELECT * FROM ${table('ai_providers')} WHERE user_id IS NULL AND is_default = true AND enabled = true LIMIT 1`,
  );
  if (!fallback.rows[0]) {
    throw new AiProviderError('AI_PROVIDER_NOT_CONFIGURED', '尚未配置可用的 AI 渠道', 409);
  }
  await assertSafeProviderUrl(fallback.rows[0].base_url);
  return rowSecret(fallback.rows[0]);
}

export async function markAiProviderTest(userId: string | number, id: string, status: string) {
  await ensureStore();
  const uid = numericUserId(userId);
  await database().query(
    `UPDATE ${table('ai_providers')} SET last_tested_at = NOW(), last_test_status = $3, updated_at = NOW()
     WHERE id = $1 AND (user_id = $2 OR (user_id IS NULL AND is_default = true AND enabled = true))`,
    [id, uid, String(status).slice(0, 200)],
  );
}

export async function markAdminAiProviderTest(id: string, status: string) {
  await ensureStore();
  await database().query(
    `UPDATE ${table('ai_providers')} SET last_tested_at = NOW(), last_test_status = $2, updated_at = NOW()
     WHERE id = $1 AND user_id IS NULL`,
    [id, String(status).slice(0, 200)],
  );
}

export async function readAiPreferences(userId: string | number): Promise<Record<string, AiPreference>> {
  await ensureStore();
  const result = await database().query(
    `SELECT workflow, provider_id, model, autonomy, updated_at FROM ${table('ai_preferences')} WHERE user_id = $1`,
    [numericUserId(userId)],
  );
  const preferences: Record<string, AiPreference> = {};
  for (const row of result.rows) {
    preferences[row.workflow] = {
      workflow: row.workflow,
      providerId: row.provider_id || null,
      model: row.model || '',
      autonomy: normalizeAutonomy(row.autonomy),
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    };
  }
  return preferences;
}

export async function writeAiPreference(
  userId: string | number,
  input: { workflow?: unknown; providerId?: unknown; model?: unknown; autonomy?: unknown },
): Promise<AiPreference> {
  await ensureStore();
  const uid = numericUserId(userId);
  const workflow = String(input.workflow || 'map.coauthor');
  if (!WORKFLOW_PATTERN.test(workflow)) throw new AiProviderError('INVALID_WORKFLOW', 'workflow 不合法');
  const providerId = input.providerId === null || input.providerId === undefined ? null : String(input.providerId);
  if (providerId) await getAiProviderSecret(uid, providerId);
  const model = String(input.model || '').slice(0, 200);
  const autonomy = normalizeAutonomy(input.autonomy);
  const result = await database().query(
    `INSERT INTO ${table('ai_preferences')} (user_id, workflow, provider_id, model, autonomy, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (user_id, workflow) DO UPDATE
     SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, autonomy = EXCLUDED.autonomy, updated_at = NOW()
     RETURNING workflow, provider_id, model, autonomy, updated_at`,
    [uid, workflow, providerId, model, autonomy],
  );
  const row = result.rows[0];
  return {
    workflow: row.workflow,
    providerId: row.provider_id || null,
    model: row.model || '',
    autonomy: normalizeAutonomy(row.autonomy),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
  };
}

// ── admin default channels ────────────────────────────────────────────────

export async function listAdminAiProviders(): Promise<AiProviderPublic[]> {
  await ensureStore();
  const result = await database().query(
    `SELECT * FROM ${table('ai_providers')} WHERE user_id IS NULL ORDER BY is_default DESC, name`,
  );
  return result.rows.map(rowPublic);
}

export async function getAdminAiProviderSecret(id: string): Promise<AiProviderSecret> {
  await ensureStore();
  const result = await database().query(
    `SELECT * FROM ${table('ai_providers')} WHERE id = $1 AND user_id IS NULL`,
    [id],
  );
  if (!result.rows[0]) throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '管理员渠道不存在', 404);
  return rowSecret(result.rows[0]);
}

export async function createAdminAiProvider(input: AiProviderInput): Promise<AiProviderPublic> {
  await ensureStore();
  const name = text(input.name, '渠道名', 64);
  const protocol = normalizeProtocol(input.protocol);
  const baseUrl = await assertSafeProviderUrl(text(input.baseUrl, 'Base URL', 2048));
  const apiKey = String(input.apiKey || '');
  if (!apiKey) throw new AiProviderError('PROVIDER_KEY_REQUIRED', 'API Key 必填');
  const secret = encryptAiProviderKey(apiKey);
  const models = normalizeModels(input.models);
  const headers = normalizeHeaders(input.headers);
  const capabilities = normalizeCapabilities(input.capabilities);
  const db = database();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('box.ai.admin-default'))");
    const existing = await client.query(`SELECT id FROM ${table('ai_providers')} WHERE user_id IS NULL LIMIT 1`);
    const makeDefault = existing.rowCount === 0;
    const result = await client.query(
      `INSERT INTO ${table('ai_providers')}
       (user_id, is_default, name, protocol, base_url, api_key_cipher, api_key_iv, api_key_tag, key_version, key_hint,
        default_model, models, headers, capabilities, enabled)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)
       RETURNING *`,
      [makeDefault, name, protocol, baseUrl, secret.ciphertext, secret.iv, secret.tag, secret.version, secret.hint,
        optionalText(input.defaultModel, '默认模型', 200) || '', JSON.stringify(models), JSON.stringify(headers),
        JSON.stringify(capabilities), input.enabled !== false],
    );
    await client.query('COMMIT');
    return rowPublic(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw new AiProviderError('AI_PROVIDER_NAME_EXISTS', '同名管理员渠道已存在');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAdminAiProvider(id: string, input: AiProviderInput): Promise<AiProviderPublic> {
  await ensureStore();
  const db = database();
  const current = await db.query(`SELECT * FROM ${table('ai_providers')} WHERE id = $1 AND user_id IS NULL`, [id]);
  if (!current.rows[0]) throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '管理员渠道不存在', 404);
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (input.name !== undefined) push('name', text(input.name, '渠道名', 64));
  if (input.protocol !== undefined) push('protocol', normalizeProtocol(input.protocol));
  if (input.baseUrl !== undefined) push('base_url', await assertSafeProviderUrl(text(input.baseUrl, 'Base URL', 2048)));
  if (input.defaultModel !== undefined) push('default_model', optionalText(input.defaultModel, '默认模型', 200) || '');
  if (input.models !== undefined) push('models', JSON.stringify(normalizeModels(input.models)));
  if (input.headers !== undefined) push('headers', JSON.stringify(normalizeHeaders(input.headers)));
  if (input.capabilities !== undefined) push('capabilities', JSON.stringify(normalizeCapabilities(input.capabilities)));
  if (input.enabled !== undefined) push('enabled', Boolean(input.enabled));
  if (input.apiKey !== undefined && String(input.apiKey).trim()) {
    const secret = encryptAiProviderKey(String(input.apiKey));
    push('api_key_cipher', secret.ciphertext);
    push('api_key_iv', secret.iv);
    push('api_key_tag', secret.tag);
    push('key_version', secret.version);
    push('key_hint', secret.hint);
  }
  if (!sets.length) return rowPublic(current.rows[0]);
  values.push(id);
  const result = await db.query(
    `UPDATE ${table('ai_providers')} SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length} AND user_id IS NULL RETURNING *`,
    values,
  );
  return rowPublic(result.rows[0]);
}

export async function setAdminDefaultAiProvider(id: string) {
  await ensureStore();
  const db = database();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('box.ai.admin-default'))");
    const exists = await client.query(`SELECT id FROM ${table('ai_providers')} WHERE id = $1 AND user_id IS NULL AND enabled = true`, [id]);
    if (!exists.rows[0]) throw new AiProviderError('AI_PROVIDER_NOT_FOUND', '管理员渠道不存在', 404);
    await client.query(`UPDATE ${table('ai_providers')} SET is_default = false WHERE user_id IS NULL`);
    await client.query(`UPDATE ${table('ai_providers')} SET is_default = true, updated_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAdminAiProvider(id: string) {
  await ensureStore();
  const result = await database().query(
    `DELETE FROM ${table('ai_providers')} WHERE id = $1 AND user_id IS NULL`,
    [id],
  );
  return (result.rowCount || 0) > 0;
}

export async function readAiExecutionPolicy() {
  await ensureStore();
  const result = await database().query(`SELECT enabled, blocked_users, blocked_maps FROM ${table('ai_execution_policy')} WHERE id = 1`);
  const row = result.rows[0];
  return {enabled: row.enabled === true, blockedUsers: row.blocked_users as string[], blockedMaps: row.blocked_maps as string[]};
}
export async function writeAiExecutionPolicy(input: Record<string, unknown>) {
  await ensureStore();
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))) {
      throw new AiProviderError('INVALID_POLICY', 'Invalid blocked IDs');
    }
    return [...new Set(value)];
  };
  if (typeof input.enabled !== 'boolean') throw new AiProviderError('INVALID_POLICY', 'enabled must be boolean');
  await database().query(`UPDATE ${table('ai_execution_policy')} SET enabled = $1, blocked_users = $2::jsonb, blocked_maps = $3::jsonb, updated_at = NOW() WHERE id = 1`,
    [input.enabled, JSON.stringify(ids(input.blockedUsers ?? [])), JSON.stringify(ids(input.blockedMaps ?? []))]);
  return readAiExecutionPolicy();
}
