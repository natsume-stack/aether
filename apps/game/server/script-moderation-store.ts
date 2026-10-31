import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { playerAdminStore } from './player-admin-identity'
import { PlayerAdminRequestError } from './player-admin-errors'
import { readAdminMapCatalog, adminAuthorizationMaps } from './admin-map-catalog'
import { checkPlayerDatabaseReady, type AdminActionContext } from './local-player-identity'
import { writeScriptModerationAudit } from './script-moderation-audit'

// Match the launcher's immutable map identity, not its editable access URL.
export const mapIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
export function canonicalModerationIP(value: string): string {
  const address = value.trim().toLowerCase()
  if (isIP(address) === 4) return address
  if (isIP(address) !== 6) return ''
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const mapped = canonical.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
    if (!mapped) return canonical
    const high = parseInt(mapped[1], 16),
      low = parseInt(mapped[2], 16)
    return [high >> 8, high & 255, low >> 8, low & 255].join('.')
  } catch {
    return ''
  }
}
export const moderationPermissionsSchema = z.array(z.enum(['players.view', 'players.ban', 'identity-bans.manage', 'moderation.view'])).min(1).max(4)
export const keyCreateSchema = z
  .object({
    mapId: mapIdSchema,
    mode: z.enum(['edit', 'play']).default('play'),
    name: z.string().trim().min(1).max(64).optional(),
    permissions: moderationPermissionsSchema.default(['players.view', 'players.ban']),
    scope: z.enum(['map', 'server']).default('server').transform(() => 'server' as const),
    maximumBanSeconds: z.union([z.literal(0), z.number().int().min(60).max(604800)]).default(3600),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
export const bindingSchema = z
  .object({
    mapId: mapIdSchema,
    keyId: z.string().uuid(),
    mode: z.enum(['edit', 'play']).default('play'),
  })
  .strict()

/** 授权记录只存在于身份服务，不写入地图工程、运行清单或脚本资源。 */
export class ScriptModerationStore {
  private initialized?: Promise<void>
  private ipHashSalt = ''
  hashIP(value: string): string {
    if (!this.ipHashSalt) throw new PlayerAdminRequestError('地图封禁存储未就绪', 503)
    return createHmac('sha256', this.ipHashSalt).update(canonicalModerationIP(value)).digest('hex')
  }
  hashDevice(value: string): string {
    if (!this.ipHashSalt) throw new PlayerAdminRequestError('地图封禁存储未就绪', 503)
    return createHmac('sha256', this.ipHashSalt).update(`device:${value}`).digest('hex')
  }
  async ready() {
    // Owners can configure script moderation before the first player signs in.
    // Reconciliation depends on the identity-ban tables from the player store.
    await checkPlayerDatabaseReady()
    const storage = await playerAdminStore()
    if (!this.initialized)
      this.initialized = this.initialize(storage).catch((error) => {
        this.initialized = undefined
        throw error
      })
    await this.initialized
    return storage
  }
  private async initialize({ pool, table }: Awaited<ReturnType<typeof playerAdminStore>>) {
    // Persist the salt so rotating internal transport credentials cannot silently clear IP bans.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${table('script_moderation_secrets')} (name TEXT PRIMARY KEY, secret TEXT NOT NULL)`,
    )
    await pool.query(
      `INSERT INTO ${table('script_moderation_secrets')}(name,secret) VALUES('ip-hash-salt',$1) ON CONFLICT(name) DO NOTHING`,
      [randomBytes(32).toString('hex')],
    )
    this.ipHashSalt = (
      await pool.query(`SELECT secret FROM ${table('script_moderation_secrets')} WHERE name='ip-hash-salt'`)
    ).rows[0].secret
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table('script_admin_keys')} (
      id UUID PRIMARY KEY, admin_id UUID NOT NULL REFERENCES ${table('admin_accounts')}(id) ON DELETE CASCADE,
      name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('map','server')),
      maximum_ban_seconds INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by TEXT NOT NULL
    )`)
    // Keep legacy account-bound grants restricted until owners explicitly replace them.
    await pool.query(`ALTER TABLE ${table('script_admin_keys')} ALTER COLUMN admin_id DROP NOT NULL`)
    await pool.query(`ALTER TABLE ${table('script_admin_keys')} ADD COLUMN IF NOT EXISTS permissions TEXT[]`)
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table('script_runtime_metadata')} (
      map_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('edit','play')), name TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(map_id,mode)
    )`)
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table('script_admin_bindings')} (
      map_id TEXT PRIMARY KEY, key_id UUID NOT NULL REFERENCES ${table('script_admin_keys')}(id) ON DELETE CASCADE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT NOT NULL
    )`)
    await pool.query(`ALTER TABLE ${table('script_runtime_metadata')} DROP COLUMN IF EXISTS fingerprint`)
    await pool.query(`ALTER TABLE ${table('script_admin_bindings')} DROP COLUMN IF EXISTS script_fingerprint`)
    await pool.query(`ALTER TABLE ${table('script_runtime_metadata')} ADD COLUMN IF NOT EXISTS group_id TEXT`)
    await pool.query(`ALTER TABLE ${table('script_runtime_metadata')} ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await pool.query(`ALTER TABLE ${table('script_admin_bindings')} ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'play'`)
    await pool.query(`ALTER TABLE ${table('script_admin_bindings')} DROP CONSTRAINT IF EXISTS script_admin_bindings_pkey`)
    // Collapse old mode-specific bindings once, retaining the owner's latest choice.
    // Lock and migrate atomically so no request can create a duplicate in between.
    const migration = await pool.connect()
    try {
      await migration.query('BEGIN')
      await migration.query(`LOCK TABLE ${table('script_admin_bindings')} IN ACCESS EXCLUSIVE MODE`)
      await migration.query(`DELETE FROM ${table('script_admin_bindings')} older
        USING ${table('script_admin_bindings')} newer
        WHERE older.map_id=newer.map_id AND
        (older.updated_at,older.key_id,older.mode)<(newer.updated_at,newer.key_id,newer.mode)`)
      await migration.query(`CREATE UNIQUE INDEX IF NOT EXISTS script_admin_bindings_map ON ${table('script_admin_bindings')}(map_id)`)
      await migration.query(`DROP INDEX IF EXISTS ${table('script_admin_bindings_map_mode')}`)
      // Existing owner-issued map grants now allow the unified server default.
      // Historical punishments retain their original scope.
      await migration.query(`UPDATE ${table('script_admin_keys')} k SET scope='server'
        WHERE k.admin_id IS NULL AND k.revoked_at IS NULL AND k.scope='map'
        AND EXISTS (SELECT 1 FROM ${table('script_admin_bindings')} b WHERE b.key_id=k.id)`)
      await migration.query('COMMIT')
    } catch (error) {
      await migration.query('ROLLBACK')
      throw error
    } finally { migration.release() }
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table('script_moderation_bans')} (
      id UUID PRIMARY KEY, key_id UUID REFERENCES ${table('script_admin_keys')}(id) ON DELETE SET NULL,
      map_id TEXT NOT NULL, subject_id UUID NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('account','ip','device')),
      scope TEXT NOT NULL, ip_hash TEXT, reference_id TEXT, effect_marker TEXT,
      reason TEXT NOT NULL, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
    await pool.query(`ALTER TABLE ${table('script_moderation_bans')} ALTER COLUMN expires_at DROP NOT NULL`)
    await pool.query(`ALTER TABLE ${table('script_moderation_bans')} ADD COLUMN IF NOT EXISTS device_hash TEXT`)
    await pool.query(`ALTER TABLE ${table('script_moderation_bans')} DROP CONSTRAINT IF EXISTS script_moderation_bans_kind_check`)
    await pool.query(`ALTER TABLE ${table('script_moderation_bans')} ADD CONSTRAINT script_moderation_bans_kind_check CHECK(kind IN ('account','ip','device'))`)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS script_bans_map_active ON ${table('script_moderation_bans')}(map_id, expires_at) WHERE revoked_at IS NULL`,
    )
    await pool.query(`CREATE INDEX IF NOT EXISTS script_bans_map_history ON ${table('script_moderation_bans')}(map_id,created_at DESC,id DESC)`)
    // Reconcile historical manual unbans that predate linked-record updates.
    await pool.query(`UPDATE ${table('script_moderation_bans')} b
      SET revoked_at=i.revoked_at FROM ${table('identity_bans')} i
      WHERE b.scope='server' AND b.kind=i.kind AND b.reference_id=i.id::text
      AND i.revoked_at IS NOT NULL AND b.revoked_at IS NULL`)
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table('script_moderation_requests')} (
      key_id UUID NOT NULL REFERENCES ${table('script_admin_keys')}(id) ON DELETE CASCADE,
      map_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL,
      result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(key_id,map_id,request_id)
    )`)
  }
  async list() {
    const { pool, table } = await this.ready()
    const keys =
      await pool.query(`SELECT k.id, k.admin_id AS "adminId", a.display_name AS "adminName", k.name,k.permissions,
      k.scope, k.maximum_ban_seconds AS "maximumBanSeconds", k.expires_at AS "expiresAt", k.revoked_at AS "revokedAt"
      FROM ${table('script_admin_keys')} k LEFT JOIN ${table('admin_accounts')} a ON a.id=k.admin_id ORDER BY k.created_at DESC LIMIT 200`)
    const maps =
      await pool.query(`SELECT map_id AS "mapId",COALESCE(group_id,map_id) AS "groupId",name,map_id AS "projectId",COALESCE(details->>'publicId','') AS "publicId",COALESCE(details->>'description','') AS description,COALESCE(details->>'version','') AS version,mode,observed_at AS "observedAt"
      FROM ${table('script_runtime_metadata')}
      ORDER BY COALESCE(group_id,map_id),mode,map_id LIMIT 200`)
    const bindings = await pool.query(
      `SELECT map_id AS "mapId",mode, key_id AS "keyId" FROM ${table('script_admin_bindings')} ORDER BY updated_at DESC LIMIT 200`,
    )
    const bans =
      await pool.query(`SELECT id,map_id AS "mapId",subject_id AS "subjectId",kind,reason,expires_at AS "expiresAt"
      FROM ${table('script_moderation_bans')} WHERE scope='map' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 200`)
    const [creator, play] = await Promise.all([
      readAdminMapCatalog('creator'), readAdminMapCatalog('play'),
    ])
    const catalogMaps = [...adminAuthorizationMaps(creator, 'edit'), ...adminAuthorizationMaps(play, 'play')]
    const mergedMaps = new Map(maps.rows.map(map => {
      // Directory metadata wins across modes; an old edit snapshot must not
      // override the actual imported map name when the Creator copy is absent.
      const source = catalogMaps.find(item => item.mapId === map.mapId)
      return [`${map.mode}:${map.mapId}`, source ? { ...map, name: source.name, groupId: source.groupId } : map]
    }))
    for (const map of catalogMaps) {
      const id = `${map.mode}:${map.mapId}`
      const previous = mergedMaps.get(id)
      mergedMaps.set(id, { ...previous, ...map, version: map.version || previous?.version || '', observedAt: previous?.observedAt || '' })
    }
    const namedMaps = [...mergedMaps.values()]
    // Older runtime snapshots used voxel dimensions as the display name.
    const namedKeys = keys.rows.map(key => {
      const binding = bindings.rows.find(item => item.keyId === key.id)
      const map = namedMaps.find(item => item.mode === binding?.mode && (item.mapId === binding.mapId || item.groupId === binding.mapId))
        || namedMaps.find(item => item.mapId === binding?.mapId || item.groupId === binding?.mapId)
      return map && /^\d+x\d+x\d+$/i.test(key.name) ? { ...key, name: map.name } : key
    })
    return { keys: namedKeys, bindings: bindings.rows, bans: bans.rows, maps: namedMaps }
  }
  async create(raw: unknown, actor: string, context?: AdminActionContext) {
    const input = keyCreateSchema.parse(raw)
    const expiry = new Date(input.expiresAt || Date.now() + 7 * 86400000)
    if (expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 360 * 86400000)
      throw new PlayerAdminRequestError('授权有效期须在未来 360 天内')
    return this.mutate(async (client, table) => {
      const id = randomUUID()
      const metadata = await this.mapMetadata(client, table, input.mapId)
      await client.query(
        `INSERT INTO ${table('script_admin_keys')}
      (id,admin_id,name,scope,maximum_ban_seconds,expires_at,created_by,permissions)
      VALUES($1,NULL,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          input.name || metadata.name,
          input.scope,
          input.maximumBanSeconds,
          expiry,
          actor,
          [...new Set(input.permissions)],
        ],
      )
      await this.saveBinding(client, table, metadata.group_id, id, actor)
      await this.audit(client, table, 'script.key.create', id, actor, { ...input, authorizationId: id, mapId: metadata.group_id, mapName: metadata.name, targetType: 'map-group', targetName: metadata.name, targetId: metadata.group_id, expiresAt: expiry.toISOString() }, context)
      return { id }
    })
  }
  async bind(raw: unknown, actor: string, context?: AdminActionContext) {
    const input = bindingSchema.parse(raw)
    return this.mutate(async (client, table) => {
      const metadata = await this.mapMetadata(client, table, input.mapId)
      await this.saveBinding(client, table, metadata.group_id, input.keyId, actor)
      await this.audit(client, table, 'script.binding.save', input.mapId, actor, { ...input, authorizationId: input.keyId, mapId: metadata.group_id, mapName: metadata.name, targetType: 'map-group', targetName: metadata.name, targetId: metadata.group_id }, context)
      return { saved: true }
    })
  }
  private async mapMetadata(client: PoolClient, table: (name: string) => string, mapId: string) {
    const [creator, play] = await Promise.all([readAdminMapCatalog('creator'), readAdminMapCatalog('play')])
    const source = [...adminAuthorizationMaps(creator, 'edit'), ...adminAuthorizationMaps(play, 'play')]
      .find(map => map.mapId === mapId || map.groupId === mapId)
    if (source) {
      const main = [...creator, ...play].find(map => map.permanentMapId === source.groupId)
      return { name: main?.name || source.name, group_id: source.groupId }
    }
    const result = await client.query<{ name: string; group_id: string }>(
      `SELECT name,COALESCE(group_id,map_id) AS group_id FROM ${table('script_runtime_metadata')}
       WHERE map_id=$1 ORDER BY mode='edit' DESC,observed_at DESC LIMIT 1 FOR SHARE`, [mapId],
    )
    if (!result.rows[0]) throw new PlayerAdminRequestError('地图组不存在，请刷新地图列表', 409)
    return result.rows[0]
  }
  private async saveBinding(
    client: PoolClient,
    table: (name: string) => string,
    mapId: string,
    keyId: string,
    actor: string,
  ) {
    const result = await client.query(
      `INSERT INTO ${table('script_admin_bindings')}(map_id,key_id,updated_by)
      SELECT $1,k.id,$3 FROM ${table('script_admin_keys')} k WHERE k.id=$2 AND k.admin_id IS NULL AND k.revoked_at IS NULL AND k.expires_at>NOW()
      ON CONFLICT(map_id) DO UPDATE SET key_id=EXCLUDED.key_id,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING map_id`,
      [mapId, keyId, actor],
    )
    if (!result.rowCount) throw new PlayerAdminRequestError('授权已失效或为旧版账号授权，请重新创建', 409)
  }
  async observeRuntime(raw: unknown) {
    const input = z
      .object({
        mapId: mapIdSchema,
        groupId: mapIdSchema.optional(),
        mode: z.enum(['edit', 'play']),
        projectId: mapIdSchema.optional(),
        publicId: z.string().max(128).optional(),
        description: z.string().max(2000).optional(),
        version: z.string().max(64).optional(),
        name: z.string().trim().min(1).max(64),
      })
      .strict()
      .parse(raw)
    const { pool, table } = await this.ready()
    await pool.query(
      `INSERT INTO ${table('script_runtime_metadata')}(map_id,mode,name,group_id,details) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(map_id,mode) DO UPDATE SET details=EXCLUDED.details,group_id=EXCLUDED.group_id,name=EXCLUDED.name,observed_at=NOW()`,
      [input.mapId, input.mode, input.name, input.groupId || input.mapId, JSON.stringify({ projectId: input.projectId, publicId: input.publicId, description: input.description, version: input.version })],
    )
    return { observed: true }
  }
  async revoke(keyId: string, actor: string, context?: AdminActionContext) {
    z.string().uuid().parse(keyId)
    return this.mutate(async (client, table) => {
      const details = await this.authorizationAuditDetails(client, table, keyId)
      const result = await client.query(
        `UPDATE ${table('script_admin_keys')} SET revoked_at=NOW() WHERE id=$1 AND revoked_at IS NULL`,
        [keyId],
      )
      if (result.rowCount) await this.audit(client, table, 'script.key.revoke', keyId, actor, details, context)
      return { revoked: true }
    })
  }
  async updateAuthorization(raw: unknown, actor: string, context?: AdminActionContext) {
    const input = bindingSchema
      .extend({ days: z.number().int().min(1).max(360).default(7), maximumBanSeconds: z.union([z.literal(0), z.number().int().min(60).max(604800)]).optional(), scope: z.enum(['map', 'server']).optional(), permissions: moderationPermissionsSchema.optional() })
      .strict()
      .parse(raw)
    return this.mutate(async (client, table) => {
      const metadata = await this.mapMetadata(client, table, input.mapId)
      const renewed = await client.query(
        `UPDATE ${table('script_admin_keys')} SET expires_at=NOW()+($2*INTERVAL '1 day'), maximum_ban_seconds=COALESCE($3,maximum_ban_seconds), scope=COALESCE($4,scope), permissions=COALESCE($5::text[],permissions)
        WHERE id=$1 AND admin_id IS NULL AND revoked_at IS NULL RETURNING id`,
        [input.keyId, input.days, input.maximumBanSeconds ?? null, 'server', input.permissions ? [...new Set(input.permissions)] : null],
      )
      if (!renewed.rowCount) throw new PlayerAdminRequestError('授权已撤销或属于旧版账号授权，请重新创建', 409)
      await this.saveBinding(client, table, metadata.group_id, input.keyId, actor)
      await this.audit(client, table, 'script.authorization.update', input.mapId, actor, { ...input, authorizationId: input.keyId, mapId: metadata.group_id, mapName: metadata.name, targetType: 'map-group', targetName: metadata.name, targetId: metadata.group_id }, context)
      return { updated: true }
    })
  }
  async unbind(mapId: string, actor: string, _mode: 'edit' | 'play' = 'play', context?: AdminActionContext) {
    const id = mapIdSchema.parse(mapId)
    return this.mutate(async (client, table) => {
      const result = await client.query(`DELETE FROM ${table('script_admin_bindings')} WHERE map_id=$1`, [id])
      if (result.rowCount) await this.audit(client, table, 'script.binding.delete', id, actor, { mapId: id, targetId: id, targetType: 'map-group' }, context)
      return { removed: true }
    })
  }
  async revokeMapBan(banId: string, actor: string, context?: AdminActionContext) {
    z.string().uuid().parse(banId)
    return this.mutate(async (client, table) => {
      const result = await client.query(
        `UPDATE ${table('script_moderation_bans')} SET revoked_at=NOW() WHERE id=$1 AND scope='map' AND revoked_at IS NULL RETURNING id`,
        [banId],
      )
      if (!result.rowCount) throw new PlayerAdminRequestError('地图封禁不存在或已解除', 404)
      await this.audit(client, table, 'script.map-ban.revoke', banId, actor, { banId, targetId: banId, targetType: 'punishment' }, context)
      return { revoked: true }
    })
  }
  private async mutate<T>(operation: (client: PoolClient, table: (name: string) => string) => Promise<T>): Promise<T> {
    const { pool, table } = await this.ready()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'")
      const result = await operation(client, table)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  private async authorizationAuditDetails(client: PoolClient, table: (name: string) => string, keyId: string) {
    const result = await client.query(`SELECT k.name,b.map_id FROM ${table('script_admin_keys')} k
      LEFT JOIN ${table('script_admin_bindings')} b ON b.key_id=k.id WHERE k.id=$1 LIMIT 1`, [keyId])
    const record = result.rows[0]
    return { authorizationId: keyId, mapId: record?.map_id, mapName: record?.name,
      targetType: 'map-group', targetName: record?.name, targetId: record?.map_id || keyId }
  }
  private audit(
    client: PoolClient,
    table: (name: string) => string,
    action: string,
    target: string,
    actor: string,
    details: Record<string, unknown>,
    context?: AdminActionContext,
  ) {
    return writeScriptModerationAudit(client, table, action, target, actor, details, context)
  }

}
export const scriptModerationStore = new ScriptModerationStore()
