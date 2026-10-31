import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { issueModerationRuntimeToken } from '@box/utils/moderation-runtime-auth'
import { checkPlayerDatabaseReady, createManagedPlayer } from '../server/local-player-identity'
import { playerAdminStore } from '../server/player-admin-identity'
import { scriptModerationStore } from '../server/script-moderation-store'
import { ModerationScript } from '../../../services/game-server/src/moderation/moderation-script'
import { ModerationHost } from '../../../services/game-server/src/moderation/moderation-host'

// Test accounts and audit evidence stay in the explicitly isolated local dev database.
const database = new URL(process.env.BOX_DATABASE_URL || 'http://invalid')
assert.equal(database.hostname, '127.0.0.1')
assert.match(database.pathname, /^\/moderation_dev_\d+$/)
const service = new URL(process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || 'http://invalid')
assert.equal(service.origin, 'http://127.0.0.1:3134')
const source = { ip: '127.0.0.1', userAgent: 'moderation-audit-simulation', deviceHash: '', actorDisplayName: '服主（脚本调用测试）' }

async function main() {
  const suffix = Date.now().toString(36)
  const mapId = `audit-sim-${suffix}`
  const runtimeId = `${mapId}-runtime`
  const mapName = '安全记录测试地图'
  process.env.BOX_WORLD_PERMANENT_MAP_ID = mapId
  process.env.MODE = 'play'
  const credentials = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sim-credential-'))
  process.env.BOX_MODERATION_CREDENTIAL_PATH = path.join(credentials, 'credential')
  fs.writeFileSync(process.env.BOX_MODERATION_CREDENTIAL_PATH, issueModerationRuntimeToken(
    { mapId, runtimeId, mode: 'play' }, process.env.BOX_MODERATION_SIGNING_SECRET || '',
  ), { mode: 0o600 })
  let grantId: string | undefined
  let banId: string | undefined
  let world: { moderation: ModerationScript } | undefined
  try {
    await checkPlayerDatabaseReady()
    await scriptModerationStore.observeRuntime({ mapId, groupId: mapId, mode: 'play', name: mapName, version: '1.0.0' })
    const grant = await scriptModerationStore.create({ mapId,
      permissions: ['players.view', 'players.ban', 'moderation.view'], maximumBanSeconds: 120,
    }, 'server-owner', source)
    grantId = grant.id
    const player = await createManagedPlayer({ username: `audit_${suffix}`, displayName: '脚本测试玩家', password: randomUUID() }, source)
    let hostHandler: any
    let scriptReply: any
    let kicked = 0
    const connection = { sessionId: 'audit-simulation', message: { reply: (message: unknown) => scriptReply(message) } }
    new ModerationHost({ protocol: () => ({ configure: (handlers: any) => { hostHandler = handlers.message.request } }) } as never,
      session => session === 'audit-simulation',
      id => id === 1 ? { userId: player.userId, ipAddress: '192.0.2.20', deviceHash: 'a'.repeat(64) } : undefined,
      () => { kicked++ },
    )
    const timers = new Map<number, ReturnType<typeof setTimeout>>()
    let timerId = 0
    world = { moderation: new ModerationScript({ protocol: () => ({
      configure: (handlers: any) => { scriptReply = handlers.message.reply },
      server: { message: { request: (message: unknown) => { void hostHandler(connection, message) } } },
    }) } as never, callback => callback(), () => 1, {
      setTimeout: (callback, ms) => { timers.set(++timerId, setTimeout(callback, ms)); return timerId },
      clearTimeout: id => { clearTimeout(timers.get(id)); timers.delete(id) },
    }) }
    const entity = {} as never
    await world.moderation.getPlayerStatus(entity)
    const options = { reason: '安全记录演示：模拟异常操作', durationSeconds: 60, requestId: `audit-ban-${suffix}` }
    const ban = await world.moderation.banPlayer(entity, options)
    banId = ban.id
    const history = await world.moderation.listBans({ player: entity, status: 'all' })
    assert.ok(history.items.some(item => item.id === ban.id))
    assert.equal((await world.moderation.getBan(ban.id))?.id, ban.id)
    await world.moderation.revokeBan(ban.id, { reason: '安全记录演示结束，解除测试处罚', requestId: `audit-revoke-${suffix}` })
    banId = undefined
    await world.moderation.banPlayer(entity, options) // Receipt replay must not reapply the ban or kick.
    assert.equal(kicked, 1)
    await scriptModerationStore.revoke(grant.id, 'server-owner', source)
    grantId = undefined
    await assert.rejects(world.moderation.getPlayerStatus(entity), /授权/)
    const { pool, table } = await playerAdminStore()
    const audit = (await pool.query(`SELECT action,ip_address,details FROM ${table('admin_audit_events')}
      WHERE details->>'mapId'=$1 ORDER BY created_at`, [mapId])).rows
    const calls = audit.filter(row => row.details.source === 'map-script')
    assert.equal(calls.length, 7)
    assert.ok(calls.every(row => row.ip_address && row.details.runtimeId === runtimeId && row.details.mapName === mapName))
    assert.ok(calls.some(row => row.action === 'script.banPlayer' && row.details.targetName === '脚本测试玩家'))
    assert.ok(calls.some(row => row.details.outcome === 'denied' && row.details.statusCode === 403))
    assert.ok(calls.some(row => row.details.result?.replayed === true))
    console.log(JSON.stringify({ mapId, mapName, playerId: player.userId, scriptCalls: calls.length,
      actions: calls.map(row => ({ api: row.details.api, outcome: row.details.outcome, sourceIp: row.ip_address })),
      testBanRevoked: true, testAuthorizationRevoked: true,
    }, null, 2))
  } finally {
    if (banId && world) await world.moderation.revokeBan(banId, { reason: '测试清理', requestId: `cleanup-${suffix}` }).catch(() => {})
    if (grantId) await scriptModerationStore.revoke(grantId, 'server-owner', source)
    fs.rmSync(credentials, { recursive: true, force: true })
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
