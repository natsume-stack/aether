import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import {
  scriptModerationStore,
  mapIdSchema,
  canonicalModerationIP,
} from './script-moderation-store'
import { normalizePlayerAdminCapabilities } from '@box/player-policy'
import { PlayerAdminRequestError } from './player-admin-errors'
import { ScriptModerationRequestError } from './script-moderation-error'
import { writeScriptModerationAudit } from './script-moderation-audit'
import {
  checkPlayerDatabaseReady,
  consumePersistentAuthRateLimit,
  createIdentityBan,
  revokeIdentityBan,
  updateManagedPlayer,
  type AdminActionContext,
} from './local-player-identity'

export const moderationCommandSchema = z
  .object({
    mapId: mapIdSchema,
    action: z.enum(['banPlayer', 'banCurrentIP', 'banCurrentDevice', 'revokeBan', 'getPlayerStatus', 'listBans', 'getBan']),
    userId: z.string().max(128).optional(),
    ipAddress: z.string().max(64).optional(),
    deviceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    scope: z.enum(['map', 'server']).default('server'),
    durationSeconds: z.number().int().min(0).max(604800).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    banId: z.string().uuid().optional(),
    kind: z.enum(['account', 'ip', 'device']).optional(),
    status: z.enum(['active', 'expired', 'revoked', 'all']).optional(),
    page: z.number().int().min(1).max(100000).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,80}$/)
      .optional(),
  })
  .strict()
type Command = z.infer<typeof moderationCommandSchema>
type Grant = {
  id: string
  admin_id: string | null
  actor_id: string
  created_by: string
  name: string
  scope: string
  maximum_ban_seconds: number
  permissions: string[]
  display_name: string
  revoked_at: Date | null
  grant_expired: boolean
}
type Ban = {
  id: string
  key_id: string
  map_id: string
  subject_id: string
  kind: string
  scope: string
  reference_id: string | null
  effect_marker: string | null
}

/** 0 means permanent; finite grants never authorize a permanent punishment. */
export function moderationBanExpiry(seconds: number | undefined, maximumSeconds: number): Date | null {
  if (seconds === undefined || !Number.isInteger(seconds) || seconds < 0 || seconds > 604800)
    throw new ScriptModerationRequestError('durationSeconds 必须为数字整数（0–604800）；永久封禁请传数字 0，不要加引号', 'MODERATION_DURATION_INVALID')
  if (maximumSeconds !== 0 && seconds === 0)
    throw new ScriptModerationRequestError('授权不允许永久封禁', 'MODERATION_PERMANENT_FORBIDDEN', 403)
  if (maximumSeconds !== 0 && seconds > maximumSeconds)
    throw new ScriptModerationRequestError('处罚期限超过授权上限', 'MODERATION_DURATION_LIMIT_EXCEEDED')
  return seconds === 0 ? null : new Date(Date.now() + seconds * 1000)
}

/** 业务事务复用后台处罚函数；脚本不接触 Key，独立授权权限每次调用都重新读取。 */
export class ScriptModerationService {
  private hashIP(value: string): string {
    return scriptModerationStore.hashIP(value)
  }
  private async grant(
    client: PoolClient,
    table: (name: string) => string,
    input: Command,
    lock: boolean,
    _mode: 'edit' | 'play',
  ): Promise<Grant> {
    const result = await client.query<Grant>(
      `SELECT k.*,k.name AS display_name,k.created_by AS actor_id,k.expires_at<=NOW() AS grant_expired FROM ${table('script_admin_bindings')} b
      JOIN ${table('script_admin_keys')} k ON k.id=b.key_id
      LEFT JOIN LATERAL (SELECT group_id FROM ${table('script_runtime_metadata')}
        WHERE map_id=$1 ORDER BY observed_at DESC,mode LIMIT 1) m ON TRUE
      WHERE b.map_id=COALESCE(m.group_id,$1)
      ${lock ? 'FOR SHARE OF b,k' : ''}`,
      [input.mapId],
    )
    const grant = result.rows[0]
    if (!grant) throw new ScriptModerationRequestError('地图未授权', 'MODERATION_GRANT_REQUIRED', 403)
    if (grant.revoked_at) throw new ScriptModerationRequestError('地图授权已撤销', 'MODERATION_GRANT_REVOKED', 403)
    if (grant.grant_expired) throw new ScriptModerationRequestError('地图授权已过期', 'MODERATION_GRANT_EXPIRED', 403)
    if (grant.admin_id) {
      const legacy = await client.query(
        `SELECT a.display_name,g.permissions FROM ${table('admin_accounts')} a
        JOIN ${table('admin_permission_groups')} g ON g.id=a.permission_group_id WHERE a.id=$1 AND a.status='active'
        ${lock ? 'FOR SHARE OF a,g' : ''}`,
        [grant.admin_id],
      )
      if (!legacy.rows[0]) throw new ScriptModerationRequestError('旧版账号授权已失效，请由服主重新创建授权', 'MODERATION_LEGACY_GRANT_INVALID', 403)
      grant.permissions = legacy.rows[0].permissions
      grant.display_name = legacy.rows[0].display_name
      grant.actor_id = grant.admin_id
    }
    return grant
  }
  private permission(grant: Grant, action: string, kind?: string): void {
    if (action === 'listBans' || action === 'getBan') {
      if (!grant.permissions?.includes('moderation.view')) throw new ScriptModerationRequestError('授权不允许查询处罚记录与详情', 'MODERATION_QUERY_FORBIDDEN', 403)
      return
    }
    const required =
      action === 'getPlayerStatus'
        ? 'players.view'
        : action === 'banCurrentIP' || action === 'banCurrentDevice' || kind === 'ip' || kind === 'device'
          ? 'identity-bans.manage'
          : 'players.ban'
    if (!normalizePlayerAdminCapabilities(grant.permissions).includes(required))
      throw new ScriptModerationRequestError('授权不允许此操作', 'MODERATION_ACTION_FORBIDDEN', 403)
  }
  private async limit(mapId: string, keyId?: string): Promise<void> {
    const limits: Array<[string, string, number]> = keyId
      ? [['script-moderation-key', keyId, 60]]
      : [['script-moderation-map', mapId, 20]]
    for (const [scope, key, max] of limits) {
      const result = await consumePersistentAuthRateLimit(scope, key, max, 60000)
      if (!result) throw new ScriptModerationRequestError('限流服务不可用', 'MODERATION_RATE_LIMIT_UNAVAILABLE', 503)
      if (!result.allowed)
        throw new ScriptModerationRequestError('脚本管理操作过于频繁', 'MODERATION_RATE_LIMITED', 429, result.retryAfterSeconds)
    }
  }
  async execute(raw: unknown, hostContext: AdminActionContext, mode: 'edit' | 'play' = 'play', runtime?: { runtimeId: string; mode: 'edit' | 'play' }) {
    const input = moderationCommandSchema.parse(raw)
    await checkPlayerDatabaseReady()
    const { pool, table } = await scriptModerationStore.ready()
    const client = await pool.connect()
    let auditGrant: Grant | undefined
    try {
      await this.limit(input.mapId)
      const preliminary = await this.grant(client, table, input, false, mode)
      auditGrant = preliminary
      await this.limit(input.mapId, preliminary.id)
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'")
      const grant = await this.grant(client, table, input, true, mode)
      auditGrant = grant
      // Re-check live permissions even for an idempotent replay.
      if (input.action === 'revokeBan') {
        const previous = await client.query<Ban>(
          `SELECT * FROM ${table('script_moderation_bans')} WHERE id=$1 AND key_id=$2 AND map_id=$3`,
          [input.banId || null, grant.id, input.mapId],
        )
        if (!previous.rows[0]) throw new ScriptModerationRequestError('处罚记录无权访问', 'MODERATION_BAN_ACCESS_DENIED', 403)
        this.permission(grant, input.action, previous.rows[0].kind)
        if (previous.rows[0].scope === 'server' && grant.scope !== 'server')
          throw new ScriptModerationRequestError('授权未授权全服处罚', 'MODERATION_SERVER_BAN_FORBIDDEN', 403)
      } else this.permission(grant, input.action)
      if (['banPlayer', 'banCurrentIP', 'banCurrentDevice'].includes(input.action) && input.scope === 'server' && grant.scope !== 'server')
        throw new ScriptModerationRequestError('授权未授权全服处罚', 'MODERATION_SERVER_BAN_FORBIDDEN', 403)
      const context: AdminActionContext = {
        ...hostContext,
        actor: `script-key:${grant.id}`,
        actorDisplayName: `${grant.display_name} / 地图 ${input.mapId}`,
        actorRole: 'moderator',
        actorPermissions: normalizePlayerAdminCapabilities(grant.permissions),
      }
      const readOnly = ['getPlayerStatus', 'listBans', 'getBan'].includes(input.action)
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      if (!readOnly) {
        if (!input.requestId)
          throw new ScriptModerationRequestError('写操作须提供 requestId', 'MODERATION_REQUEST_ID_INVALID')
        if (!input.reason)
          throw new ScriptModerationRequestError('处罚/解除原因必填', 'MODERATION_REASON_INVALID')
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${grant.id}:${input.mapId}:${input.requestId}`,
        ])
        const replay = await client.query(
          `SELECT body_hash,result FROM ${table('script_moderation_requests')} WHERE key_id=$1 AND map_id=$2 AND request_id=$3`,
          [grant.id, input.mapId, input.requestId],
        )
        if (replay.rows[0]) {
          if (replay.rows[0].body_hash !== hash) throw new ScriptModerationRequestError('requestId 已用于不同操作', 'MODERATION_REQUEST_ID_CONFLICT', 409)
          await this.auditCall(client, table, input, hostContext, grant, mode, runtime, { ...replay.rows[0].result, replayed: true })
          await client.query('COMMIT')
          return { ...replay.rows[0].result, replayed: true }
        }
      }
      const result =
        input.action === 'listBans' || input.action === 'getBan'
          ? await this.readBans(client, table, input)
          : input.action === 'revokeBan'
          ? await this.revoke(client, table, input, grant, context)
          : await this.apply(client, table, input, grant, context)
      if (!readOnly) {
        await client.query(
          `INSERT INTO ${table('script_moderation_requests')}(key_id,map_id,request_id,body_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [grant.id, input.mapId, input.requestId, hash, JSON.stringify(result)],
        )
      }
      await this.auditCall(client, table, input, hostContext, grant, mode, runtime, result)
      await client.query('COMMIT')
      return { ...result, replayed: false }
    } catch (error) {
      await client.query('ROLLBACK')
      try {
        await this.auditCall(client, table, input, hostContext, auditGrant, mode, runtime, undefined, error)
      } catch (auditError) {
        console.error('Unable to record script moderation failure', auditError)
      }
      throw error
    } finally {
      client.release()
    }
  }
  private async auditCall(
    client: PoolClient, table: (name: string) => string, input: Command,
    source: AdminActionContext, grant: Grant | undefined, mode: 'edit' | 'play',
    runtime: { runtimeId: string; mode: 'edit' | 'play' } | undefined,
    result?: Record<string, unknown>, error?: unknown,
  ) {
    const metadata = (await client.query(`SELECT name,COALESCE(group_id,map_id) AS group_id
      FROM ${table('script_runtime_metadata')} WHERE map_id=$1
      ORDER BY mode='edit' DESC,observed_at DESC LIMIT 1`, [input.mapId])).rows[0]
    const mapName = metadata?.name && !/^\d+x\d+x\d+$/i.test(metadata.name)
      ? metadata.name : grant?.name || input.mapId
    const player = input.userId ? (await client.query(`SELECT username,display_name FROM ${table('users')}
      WHERE id::text=$1 LIMIT 1`, [input.userId])).rows[0] : undefined
    const statusCode = error instanceof PlayerAdminRequestError ? error.status : undefined
    const outcome = error ? (statusCode === 403 || statusCode === 401 ? 'denied' : 'failure') : 'success'
    const receipt = result?.ban && typeof result.ban === 'object' ? result.ban as Record<string, unknown> : result
    const summary = receipt ? Object.fromEntries(['id','status','kind','scope','reason','userId','createdAt','revokedAt','expiresAt','total','page','pageSize','replayed']
      .filter(key => key in receipt).map(key => [key, receipt[key]])) : undefined
    await writeScriptModerationAudit(client, table, `script.${input.action}`, input.userId || input.banId || input.mapId,
      `script-map:${input.mapId}`, {
        source: 'map-script', api: input.action, outcome,
        mapId: input.mapId, mapName, groupId: metadata?.group_id || input.mapId,
        authorizationId: grant?.id, runtimeId: runtime?.runtimeId, runtimeMode: runtime?.mode || mode,
        targetType: input.userId ? 'player' : input.banId ? 'punishment' : 'map',
        targetName: player?.display_name || player?.username || (input.userId ? `玩家 ${input.userId}` : input.banId ? '处罚记录' : mapName),
        targetId: input.userId || input.banId || input.mapId, userId: input.userId,
        requestId: input.requestId, reason: input.reason || summary?.reason, scope: summary?.scope || input.scope,
        kind: summary?.kind || (input.action === 'banCurrentIP' ? 'ip' : input.action === 'banCurrentDevice' ? 'device' : input.action === 'banPlayer' ? 'account' : input.kind),
        durationSeconds: /^ban/.test(input.action) ? input.durationSeconds ?? grant?.maximum_ban_seconds : undefined, banId: input.banId || result?.id,
        targetIp: input.action === 'banCurrentIP' ? input.ipAddress : undefined,
        deviceBan: input.action === 'banCurrentDevice' ? true : undefined,
        result: summary, error: error instanceof Error ? error.message : error ? '调用失败' : undefined,
        statusCode,
      }, { ...source, actorDisplayName: `${mapName} / 地图脚本` })
  }
  private async readBans(client: PoolClient, table: (name: string) => string, input: Command) {
    if (input.action === 'getBan' && !input.banId) throw new ScriptModerationRequestError('处罚 ID 必填', 'MODERATION_BAN_ID_INVALID')
    const page = input.page ?? 1, pageSize = input.pageSize ?? 20
    // Always constrain reads to the trusted runtime map, including historical grants.
    // Deliberately omit IP/device hashes, principal IDs and grant/admin identifiers.
    const status = `CASE WHEN b.revoked_at IS NOT NULL THEN 'revoked' WHEN b.expires_at IS NOT NULL AND b.expires_at<=NOW() THEN 'expired' ELSE 'active' END`
    const where = `b.map_id=$1 AND ($2::uuid IS NULL OR b.id=$2) AND ($3::text IS NULL OR u.id::text=$3)
      AND ($4::text IS NULL OR b.kind=$4) AND ($5::text IS NULL OR $5='all' OR (${status})=$5)`
    const parameters = [input.mapId, input.action === 'getBan' ? input.banId : null, input.userId ?? null, input.kind ?? null, input.status ?? null]
    const count = await client.query(`SELECT COUNT(*)::integer AS total FROM ${table('script_moderation_bans')} b
      LEFT JOIN ${table('users')} u ON u.principal_id=b.subject_id WHERE ${where}`, parameters)
    const result = await client.query(`SELECT b.id,b.kind,b.scope,u.id::text AS "userId",b.reason,
      b.created_at AS "createdAt",b.expires_at AS "expiresAt",b.revoked_at AS "revokedAt",(${status}) AS status,
      CASE WHEN b.revoked_at IS NOT NULL OR b.expires_at<=NOW() THEN 0 WHEN b.expires_at IS NULL THEN NULL
        ELSE CEIL(EXTRACT(EPOCH FROM (b.expires_at-NOW())))::integer END AS "remainingSeconds"
      FROM ${table('script_moderation_bans')} b LEFT JOIN ${table('users')} u ON u.principal_id=b.subject_id
      WHERE ${where} ORDER BY b.created_at DESC,b.id DESC LIMIT $6 OFFSET $7`, [...parameters, input.action === 'getBan' ? 1 : pageSize, (page-1)*pageSize])
    return input.action === 'getBan' ? { ban: result.rows[0] ?? null } : { items: result.rows, total: count.rows[0].total, page, pageSize }
  }
  private async target(client: PoolClient, table: (name: string) => string, userId?: string) {
    if (!userId) throw new ScriptModerationRequestError('目标玩家无效', 'MODERATION_TARGET_INVALID')
    const result = await client.query<{ principal_id: string; role: string; status: string; effect_marker: string }>(
      `SELECT principal_id,role,status,updated_at::text AS effect_marker FROM ${table('users')} WHERE id::text=$1 FOR UPDATE`,
      [userId],
    )
    if (!result.rows[0]) throw new ScriptModerationRequestError('玩家不存在', 'MODERATION_PLAYER_NOT_FOUND', 404)
    if (result.rows[0].role !== 'player') throw new ScriptModerationRequestError('脚本不能操作受保护的管理身份', 'MODERATION_ADMIN_PROTECTED', 403)
    return result.rows[0]
  }
  private async apply(
    client: PoolClient,
    table: (name: string) => string,
    input: Command,
    grant: Grant,
    context: AdminActionContext,
  ) {
    this.permission(grant, input.action)
    const target = await this.target(client, table, input.userId)
    if (input.action === 'getPlayerStatus') {
      const bans = await client.query(
        `SELECT id,kind,scope,reason,expires_at AS "expiresAt" FROM ${table('script_moderation_bans')} WHERE subject_id=$1 AND map_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 50`,
        [target.principal_id, input.mapId],
      )
      return { status: target.status, bans: bans.rows }
    }
    if (input.scope === 'server' && grant.scope !== 'server')
      throw new ScriptModerationRequestError('授权未授权全服处罚', 'MODERATION_SERVER_BAN_FORBIDDEN', 403)
    const expiry = moderationBanExpiry(input.durationSeconds, grant.maximum_ban_seconds)
    const kind = input.action === 'banCurrentIP' ? 'ip' : input.action === 'banCurrentDevice' ? 'device' : 'account'
    if (kind === 'device' && !input.deviceHash) throw new ScriptModerationRequestError('目标连接没有可信的设备身份', 'MODERATION_DEVICE_UNAVAILABLE')
    if (kind === 'device') {
      const protectedDevice = await client.query(
        `SELECT 1 FROM ${table('sessions')} s JOIN ${table('users')} u ON u.principal_id=s.principal_id
         WHERE s.device_hash=$1 AND s.expires_at>NOW() AND (u.role<>'player' OR cardinality(u.admin_permissions)>0) LIMIT 1`,
        [input.deviceHash],
      )
      if (protectedDevice.rowCount) throw new ScriptModerationRequestError('该设备正用于管理身份，需由管理员人工复核', 'MODERATION_DEVICE_PROTECTED', 403)
    }
    const ip = canonicalModerationIP(String(input.ipAddress || ''))
    if (kind === 'ip' && (!isIP(ip) || ip.startsWith('127.') || ['::1', '0.0.0.0', '::'].includes(ip)))
      throw new ScriptModerationRequestError('不能封禁无效地址或本机管理地址', 'MODERATION_IP_INVALID')
    let reference: string | null = null
    let marker: string | null = null
    const ipHash = kind === 'ip' ? this.hashIP(ip) : null
    const deviceHash = kind === 'device' ? scriptModerationStore.hashDevice(input.deviceHash!) : null
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${input.mapId}:${input.scope}:${kind}:${deviceHash || ipHash || target.principal_id}`,
    ])
    const duplicate = await client.query(
      `SELECT 1 FROM ${table('script_moderation_bans')} b WHERE map_id=$1 AND scope=$2 AND kind=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) AND (($3='account' AND subject_id=$4) OR ($3='ip' AND ip_hash=$5) OR ($3='device' AND device_hash=$6))
       AND (b.scope='map' OR b.kind='account' OR EXISTS (
         SELECT 1 FROM ${table('identity_bans')} i WHERE i.id::text=b.reference_id
         AND i.revoked_at IS NULL AND (i.banned_until IS NULL OR i.banned_until>NOW())
       )) LIMIT 1`,
      [input.mapId, input.scope, kind, target.principal_id, ipHash, deviceHash],
    )
    if (duplicate.rowCount) throw new ScriptModerationRequestError('已存在对应处罚，请复核或使用原 requestId 重试', 'MODERATION_BAN_ALREADY_EXISTS', 409)
    if (input.scope === 'server') {
      if (kind === 'account') {
        if (target.status !== 'active') throw new ScriptModerationRequestError('已有账号处罚，须管理员人工复核', 'MODERATION_ACCOUNT_ALREADY_PUNISHED', 409)
        await updateManagedPlayer(
          target.principal_id,
          { status: 'banned', banReason: input.reason, bannedUntil: expiry?.toISOString() || null },
          context,
          client,
        )
        marker = (
          await client.query(`SELECT updated_at::text AS value FROM ${table('users')} WHERE principal_id=$1`, [
            target.principal_id,
          ])
        ).rows[0].value
      } else {
        reference = (
          await createIdentityBan(
            target.principal_id,
            { kind, value: kind === 'device' ? input.deviceHash! : ip, reason: input.reason, bannedUntil: expiry?.toISOString() || null },
            context,
            client,
          )
        ).id
      }
    }
    const id = randomUUID()
    await client.query(
      `INSERT INTO ${table('script_moderation_bans')}(id,key_id,map_id,subject_id,kind,scope,ip_hash,reference_id,effect_marker,reason,expires_at,device_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        grant.id,
        input.mapId,
        target.principal_id,
        kind,
        input.scope,
        ipHash,
        reference,
        marker,
        input.reason,
        expiry,
        deviceHash,
      ],
    )
    return { id, scope: input.scope, expiresAt: expiry?.toISOString() || null }
  }
  private async revoke(
    client: PoolClient,
    table: (name: string) => string,
    input: Command,
    grant: Grant,
    context: AdminActionContext,
  ) {
    if (!input.banId) throw new ScriptModerationRequestError('封禁记录无效', 'MODERATION_BAN_ID_INVALID')
    const result = await client.query<Ban>(
      `SELECT * FROM ${table('script_moderation_bans')} WHERE id=$1 AND key_id=$2 AND map_id=$3 AND revoked_at IS NULL FOR UPDATE`,
      [input.banId, grant.id, input.mapId],
    )
    const ban = result.rows[0]
    if (!ban) throw new ScriptModerationRequestError('只能解除当前授权在本图创建的处罚', 'MODERATION_BAN_ACCESS_DENIED', 403)
    this.permission(grant, input.action, ban.kind)
    if (ban.scope === 'server') {
      if (ban.kind === 'account') {
        const state = await client.query(
          `SELECT updated_at::text AS marker,status FROM ${table('users')} WHERE principal_id=$1 FOR UPDATE`,
          [ban.subject_id],
        )
        if (state.rows[0]?.marker !== ban.effect_marker || state.rows[0]?.status !== 'banned')
          throw new ScriptModerationRequestError('处罚已被管理员调整，请人工复核', 'MODERATION_BAN_CHANGED', 409)
        await updateManagedPlayer(
          ban.subject_id,
          { status: 'active', banReason: '', bannedUntil: null },
          context,
          client,
        )
      } else await revokeIdentityBan(ban.subject_id, ban.reference_id, context, client)
    }
    await client.query(`UPDATE ${table('script_moderation_bans')} SET revoked_at=NOW() WHERE id=$1`, [ban.id])
    return { revoked: true, id: ban.id }
  }
  async admission(mapId: string, userId: string, ip: string, deviceHash?: string) {
    const denied = await this.deniedPlayers(mapId, [{ userId, ipAddress: ip, deviceHash }])
    return { allowed: denied.length === 0 }
  }
  async deniedPlayers(mapId: string, players: Array<{ userId: string; ipAddress: string; deviceHash?: string }>) {
    const map = mapIdSchema.parse(mapId)
    await checkPlayerDatabaseReady()
    const { pool, table } = await scriptModerationStore.ready()
    const result = await pool.query<{ index: number }>(
      `SELECT DISTINCT p.index FROM jsonb_to_recordset($2::jsonb) AS p(index integer, "userId" text, "ipHash" text, "deviceHash" text)
      JOIN ${table('script_moderation_bans')} b ON TRUE LEFT JOIN ${table('users')} u ON u.principal_id=b.subject_id
      WHERE b.map_id=$1 AND b.scope='map' AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>NOW())
      AND ((b.kind='account' AND u.id::text=p."userId") OR (b.kind='ip' AND b.ip_hash=p."ipHash") OR (b.kind='device' AND b.device_hash=p."deviceHash"))`,
      [map, JSON.stringify(players.map((p, index) => ({ index, userId: p.userId, ipHash: this.hashIP(p.ipAddress), deviceHash: p.deviceHash ? scriptModerationStore.hashDevice(p.deviceHash) : null })))],
    )
    return result.rows.map((row) => row.index)
  }
}
export const scriptModerationService = new ScriptModerationService()
