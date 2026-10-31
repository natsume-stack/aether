import { playerBanResponse } from '../server/player-ban-response'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import { checkPlayerDatabaseReady, createManagedPlayer, resolvePlayerIdentity, createIdentityBan, revokeIdentityBan, revokeIdentityBanGlobally } from '../server/local-player-identity'
import {
  playerAdminStore,
  createPlayerAdminAccount,
  createPlayerAdminPermissionGroup,
  updatePlayerAdminAccount,
  loginPlayerAdmin,
  resolvePlayerAdminSession,
  type PlayerAdminIdentity,
} from '../server/player-admin-identity'
import { scriptModerationStore as store, ScriptModerationStore } from '../server/script-moderation-store'
import { scriptModerationService as moderation } from '../server/script-moderation-service'

// This suite creates test accounts and fault-injection triggers. Never run against a real deployment.
const url = new URL(process.env.BOX_DATABASE_URL || 'http://invalid')
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.pathname, '/moderation_test')
assert.equal(process.env.BOX_IDENTITY_DATABASE_SCHEMA, 'moderation_test')
const owner: PlayerAdminIdentity = {
  id: 'server-owner',
  username: 'owner',
  displayName: '服主',
  role: 'owner',
  permissions: [],
  status: 'active',
  credential: 'owner-session',
}
const context = { ip: '192.0.2.1', userAgent: 'isolated regression', deviceHash: '' }
const mapId = 'moderation-test-map'
async function report(map = mapId, mode: 'edit' | 'play' = 'play') {
  return store.observeRuntime({ mapId: map, mode, name: '测试地图' })
}
async function main() {
  await checkPlayerDatabaseReady()
  await report()
  const key = await store.create(
    { mapId, scope: 'map', permissions: ['players.view', 'players.ban', 'identity-bans.manage'] },
    owner.id,
  )
  const { pool, table } = await playerAdminStore()
  const row = (await pool.query(`SELECT admin_id,permissions FROM ${table('script_admin_keys')} WHERE id=$1`, [key.id]))
    .rows[0]
  assert.equal(row.admin_id, null)
  assert.ok(row.permissions.includes('players.ban'))
  const player = await createManagedPlayer(
    { username: 'test_player', displayName: '测试玩家', password: 'TestOnly_7W9q4s!Bp' },
    context,
  )
  const player2 = await createManagedPlayer(
    { username: 'test_player_two', displayName: '测试玩家二', password: 'TestOnly_7W9q4s!Bp' },
    context,
  )
  const input = {
    mapId,
    userId: player.userId,
    action: 'banPlayer',
    reason: '测试',
    durationSeconds: 120,
    requestId: 'ban-one',
    scope: 'map' as const,
  }
  // Seed a legacy restricted grant to verify historical map punishments.
  await pool.query(`UPDATE ${table('script_admin_keys')} SET scope='map' WHERE id=$1`, [key.id])
  const ban = await moderation.execute(input, context)
  assert.deepEqual(await moderation.execute(input, context), { ...ban, replayed: true })
  assert.equal((await moderation.admission(mapId, player.userId, '192.0.2.2')).allowed, false)
  assert.equal((await moderation.admission('other-map', player.userId, '192.0.2.2')).allowed, true)
  await assert.rejects(moderation.execute({ ...input, requestId: 'duplicate' }, context), /对应处罚/)
  await assert.rejects(moderation.execute({ ...input, reason: '改变重复请求' }, context), /requestId/)
  await assert.rejects(moderation.execute({ ...input, mapId: 'copied-map' }, context), /未授权/)
  await assert.rejects(moderation.execute({ ...input, scope: 'server', requestId: 'global-denied' }, context), /全服/)
  await pool.query(`UPDATE ${table('script_admin_keys')} SET permissions=ARRAY['players.view'] WHERE id=$1`, [key.id])
  await assert.rejects(moderation.execute(input, context), /授权不允许/)
  await pool.query(
    `UPDATE ${table('script_admin_keys')} SET permissions=ARRAY['players.view','players.ban','identity-bans.manage'] WHERE id=$1`,
    [key.id],
  )
  await moderation.execute(
    {
      mapId,
        action: 'revokeBan',
      banId: ban.id,
      reason: '解除',
      requestId: 'revoke-one',
    },
    context,
  )
  const ipBan = await moderation.execute(
    { ...input, action: 'banCurrentIP', ipAddress: '192.0.2.2', requestId: 'ip-ban' },
    context,
  )
  assert.equal((await moderation.admission(mapId, player2.userId, '192.0.2.2')).allowed, false)
  assert.deepEqual(
    await moderation.deniedPlayers(mapId, [
      { userId: player2.userId, ipAddress: '192.0.2.2' },
      { userId: player2.userId, ipAddress: '192.0.2.3' },
    ]),
    [0],
  )
  await store.revokeMapBan(ipBan.id, owner.id)
  await report()
  assert.ok(await moderation.execute({ ...input, action: 'getPlayerStatus' }, context))
  await report(mapId, 'edit')
  assert.equal((await store.list()).maps.filter((map) => map.mapId === mapId).length, 2)
  await pool.query(`UPDATE ${table('script_admin_keys')} SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [
    key.id,
  ])
  await assert.rejects(
    moderation.execute({ ...input, action: 'getPlayerStatus' }, context),
    {moderationStatus:'MODERATION_GRANT_EXPIRED',status:403},
  )
  await store.updateAuthorization({ mapId, keyId: key.id }, owner.id)
  assert.ok(await moderation.execute({ ...input, action: 'getPlayerStatus' }, context))
  const group = await createPlayerAdminPermissionGroup(
    { name: '旧授权组', permissions: ['players.view', 'players.ban'] },
    owner,
  )
  const admin = await createPlayerAdminAccount(
    { username: 'test_admin', displayName: '管理员', password: 'TestOnly_7W9q4s!Bp', permissionGroupId: group.id },
    owner,
  )
  // Player IP bans must not affect the independent admin login or an existing admin session.
  const adminIP = '192.0.2.9'
  const adminRequest = {headers:{host:'localhost','user-agent':'moderation-isolation-test'},socket:{remoteAddress:adminIP}} as NextApiRequest
  const responseHeaders = new Map<string, unknown>()
  const adminResponse = {getHeader:(name:string)=>responseHeaders.get(name),setHeader:(name:string,value:unknown)=>responseHeaders.set(name,value)} as unknown as NextApiResponse
  const credentials = {username:'test_admin',password:'TestOnly_7W9q4s!Bp'}
  await loginPlayerAdmin(adminRequest, adminResponse, credentials)
  const cookie = (responseHeaders.get('Set-Cookie') as string[]).map(value=>value.split(';')[0]).join('; ')
  const sessionRequest = {...adminRequest,headers:{...adminRequest.headers,cookie}} as NextApiRequest
  assert.equal((await resolvePlayerAdminSession(sessionRequest)).id, admin.id)
  await report('admin-ip-map')
  const adminIPKey = await store.create({mapId:'admin-ip-map',permissions:['identity-bans.manage']},owner.id)
  const sharedIPBan = await moderation.execute({...input,mapId:'admin-ip-map',scope:'server',action:'banCurrentIP',ipAddress:adminIP,requestId:'admin-ip-ban'}, {...context,ip:adminIP})
  await assert.rejects(resolvePlayerIdentity(adminRequest,adminResponse), (error: unknown) => {
    assert.deepEqual(playerBanResponse(error), {code:'IP_BANNED',message:'当前 IP 地址已被封禁',banKind:'ip',banReason:input.reason,bannedUntil:sharedIPBan.expiresAt})
    return true
  })
  assert.equal((await resolvePlayerAdminSession(sessionRequest)).id,admin.id)
  assert.equal((await loginPlayerAdmin(adminRequest,adminResponse,credentials)).id,admin.id)
  const originalIPRecord = (await pool.query(`SELECT reference_id FROM ${table('script_moderation_bans')} WHERE id=$1`,[sharedIPBan.id])).rows[0]
  await revokeIdentityBanGlobally(originalIPRecord.reference_id,context)
  // A pre-fix manual unban left a stale script row. Verify startup reconciliation.
  await pool.query(`UPDATE ${table('script_moderation_bans')} SET revoked_at=NULL WHERE id=$1`,[sharedIPBan.id])
  await new ScriptModerationStore().ready()
  assert.ok((await pool.query(`SELECT revoked_at FROM ${table('script_moderation_bans')} WHERE id=$1`,[sharedIPBan.id])).rows[0].revoked_at)
  const repeatedIPBan = await moderation.execute({...input,mapId:'admin-ip-map',scope:'server',action:'banCurrentIP',ipAddress:adminIP,requestId:'admin-ip-after-manual-unban'},context)
  assert.notEqual(repeatedIPBan.id,sharedIPBan.id)
  assert.ok((await pool.query(`SELECT revoked_at FROM ${table('script_moderation_bans')} WHERE id=$1`,[sharedIPBan.id])).rows[0].revoked_at)
  await moderation.execute({mapId:'admin-ip-map',action:'revokeBan',banId:repeatedIPBan.id,reason:'测试完成',requestId:'admin-ip-unban'},context)
  const deviceToken = 'test-device-token-'.padEnd(48,'a')
  const hashedDevice = createHash('sha256').update(deviceToken).digest('hex')
  const deviceRequest = {...adminRequest,headers:{...adminRequest.headers,cookie:`box_local_player_device=${deviceToken}`}} as NextApiRequest
  for (const bannedUntil of [new Date(Date.now()+120000).toISOString(),null]) {
    const identityBan = await createIdentityBan(player.subjectId,{kind:'device',value:hashedDevice,reason:'设备违规测试',bannedUntil},context)
    await assert.rejects(resolvePlayerIdentity(deviceRequest,adminResponse), (error: unknown) => {
      assert.deepEqual(playerBanResponse(error), {code:'DEVICE_BANNED',message:'当前设备已被封禁',banKind:'device',banReason:'设备违规测试',bannedUntil})
      return true
    })
    await revokeIdentityBan(player.subjectId,identityBan.id,context)
  }
  await store.revoke(adminIPKey.id,owner.id)
  await updatePlayerAdminAccount(admin.id, { status: 'disabled' }, owner)
  assert.ok(await moderation.execute({ ...input, action: 'getPlayerStatus' }, context))
  const legacyId = randomUUID()
  await pool.query(
    `INSERT INTO ${table('script_admin_keys')}(id,admin_id,name,scope,maximum_ban_seconds,expires_at,created_by) VALUES($1,$2,'legacy','map',3600,NOW()+INTERVAL '1 day','server-owner')`,
    [legacyId, admin.id],
  )
  await pool.query(
    `INSERT INTO ${table('script_admin_bindings')}(map_id,key_id,updated_by) VALUES('legacy-map',$1,'server-owner')`,
    [legacyId],
  )
  await assert.rejects(
    moderation.execute({ ...input, mapId: 'legacy-map', action: 'getPlayerStatus' }, context),
    /旧版账号授权/,
  )
  const columns = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='moderation_test' AND table_name='admin_accounts' AND column_name='console_login_enabled'`,
  )
  assert.equal(columns.rowCount, 0)
  await report('server-map')
  const globalKey = await store.create(
    {
      mapId: 'server-map',
      permissions: ['players.view', 'players.ban'],
    },
    owner.id,
  )
  const globalInput = { ...input, mapId: 'server-map', scope: undefined, requestId: 'global-ban' }
  const globalBan = await moderation.execute(globalInput, context)
  assert.equal(globalBan.scope, 'server')
  assert.equal(
    (await pool.query(`SELECT status FROM ${table('users')} WHERE id=$1`, [player.userId])).rows[0].status,
    'banned',
  )
  await moderation.execute(
    {
      mapId: 'server-map',
        action: 'revokeBan',
      banId: globalBan.id,
      reason: '复核',
      requestId: 'global-unban',
    },
    context,
  )
  await pool.query(
    `CREATE FUNCTION moderation_test.fail_script_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='script.banPlayer' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_script_audit BEFORE INSERT ON ${table('admin_audit_events')} FOR EACH ROW EXECUTE FUNCTION moderation_test.fail_script_audit()`,
  )
  await assert.rejects(
    moderation.execute({ ...globalInput, userId: player2.userId, requestId: 'rollback' }, context),
    /audit unavailable/,
  )
  assert.equal(
    (await pool.query(`SELECT status FROM ${table('users')} WHERE id=$1`, [player2.userId])).rows[0].status,
    'active',
  )
  await pool.query(
    `DROP TRIGGER fail_script_audit ON ${table('admin_audit_events')}; DROP FUNCTION moderation_test.fail_script_audit()`,
  )
  await report('device-map')
  const deviceKey = await store.create({mapId:'device-map',scope:'server',maximumBanSeconds:0,permissions:['players.view','identity-bans.manage']},owner.id)
  const deviceHash = 'a'.repeat(64)
  const deviceInput = {...input,mapId:'device-map',action:'banCurrentDevice',deviceHash,durationSeconds:0,requestId:'device-map-ban'}
  await assert.rejects(moderation.execute({...deviceInput,mapId:'server-map',requestId:'unauthorized-device'},context),/不允许此操作/)
  await store.updateAuthorization({mapId:'device-map',keyId:deviceKey.id,maximumBanSeconds:60},owner.id)
  await assert.rejects(moderation.execute({...deviceInput,requestId:'unauthorized-permanent'},context),{moderationStatus:'MODERATION_PERMANENT_FORBIDDEN',status:403})
  await store.updateAuthorization({mapId:'device-map',keyId:deviceKey.id,maximumBanSeconds:0},owner.id)
  const deviceBan = await moderation.execute(deviceInput, context)
  assert.equal(deviceBan.expiresAt,null)
  assert.equal((await moderation.admission('device-map',player2.userId,'192.0.2.99',deviceHash)).allowed,false)
  assert.equal((await moderation.admission('device-map',player2.userId,'192.0.2.99','b'.repeat(64))).allowed,true)
  assert.equal((await moderation.admission('other-map',player2.userId,'192.0.2.99',deviceHash)).allowed,true)
  await assert.rejects(moderation.execute({...deviceInput,deviceHash:undefined,requestId:'missing-device'},context),/可信的设备/)
  await moderation.execute({mapId:'device-map',action:'revokeBan',banId:deviceBan.id,reason:'复核',requestId:'device-map-unban'},context)
  assert.equal((await moderation.admission('device-map',player2.userId,'192.0.2.99',deviceHash)).allowed,true)
  const globalDeviceBan = await moderation.execute({...deviceInput,scope:'server',requestId:'device-global-ban'},context)
  const identityBan = (await pool.query(`SELECT kind,banned_until,revoked_at FROM ${table('identity_bans')} WHERE id=(SELECT reference_id::bigint FROM ${table('script_moderation_bans')} WHERE id=$1)`,[globalDeviceBan.id])).rows[0]
  assert.equal(identityBan.kind,'device')
  assert.equal(identityBan.banned_until,null)
  const scriptDeviceReference = (await pool.query(`SELECT reference_id FROM ${table('script_moderation_bans')} WHERE id=$1`,[globalDeviceBan.id])).rows[0].reference_id
  await revokeIdentityBan(player.subjectId,scriptDeviceReference,context)
  assert.ok((await pool.query(`SELECT revoked_at FROM ${table('script_moderation_bans')} WHERE id=$1`,[globalDeviceBan.id])).rows[0].revoked_at)
  const repeatedDeviceBan = await moderation.execute({...deviceInput,scope:'server',requestId:'device-after-manual-unban'},context)
  await assert.rejects(moderation.execute({...deviceInput,scope:'server',requestId:'device-still-active'},context),/对应处罚/)
  await moderation.execute({mapId:'device-map',action:'revokeBan',banId:repeatedDeviceBan.id,reason:'复核',requestId:'device-global-unban'},context)
  await store.revoke(deviceKey.id,owner.id)
  await report('query-map')
  const queryKey = await store.create({mapId:'query-map',maximumBanSeconds:0,permissions:['players.ban']},owner.id)
  const queryInput = {...input,mapId:'query-map',durationSeconds:0,requestId:'query-ban'}
  const queryBan = await moderation.execute(queryInput,context)
  await assert.rejects(moderation.execute({mapId:'query-map',action:'listBans'},context),/不允许查询处罚/)
  await assert.rejects(moderation.execute({mapId:'query-map',action:'getBan',banId:queryBan.id},context),/不允许查询处罚/)
  await store.updateAuthorization({mapId:'query-map',keyId:queryKey.id,permissions:['players.ban','moderation.view']},owner.id)
  const detail = (await moderation.execute({mapId:'query-map',action:'getBan',banId:queryBan.id},context)).ban
  assert.equal(detail.reason,'测试')
  assert.equal(detail.status,'active')
  assert.equal(detail.remainingSeconds,null)
  assert.equal(detail.userId,player.userId)
  assert.equal(detail.expiresAt,null)
  for (const forbidden of ['ip_hash','device_hash','subject_id','key_id','reference_id']) assert.equal(forbidden in detail,false)
  assert.equal((await moderation.execute({mapId:'query-map',action:'getBan',banId:globalBan.id},context)).ban,null)
  assert.equal((await moderation.execute({mapId:'query-map',action:'getBan',banId:randomUUID()},context)).ban,null)
  const expiredId=randomUUID()
  await pool.query(`INSERT INTO ${table('script_moderation_bans')}(id,key_id,map_id,subject_id,kind,scope,reason,expires_at)
    SELECT $1,key_id,map_id,subject_id,'ip',scope,'过期测试',NOW()-INTERVAL '1 minute' FROM ${table('script_moderation_bans')} WHERE id=$2`,[expiredId,queryBan.id])
  const all = await moderation.execute({mapId:'query-map',action:'listBans',page:1,pageSize:1},context)
  assert.equal(all.total,2)
  assert.equal(all.items.length,1)
  assert.equal(all.pageSize,1)
  const expired = await moderation.execute({mapId:'query-map',action:'listBans',status:'expired',kind:'ip',userId:player.userId},context)
  assert.equal(expired.items[0].id,expiredId)
  assert.equal(expired.items[0].remainingSeconds,0)
  assert.equal((await moderation.execute({mapId:'query-map',action:'listBans',userId:player2.userId},context)).total,0)
  await moderation.execute({mapId:'query-map',action:'revokeBan',banId:queryBan.id,reason:'复核',requestId:'query-unban'},context)
  const revoked = (await moderation.execute({mapId:'query-map',action:'listBans',status:'revoked'},context)).items[0]
  assert.equal(revoked.id,queryBan.id)
  assert.equal(revoked.remainingSeconds,0)
  assert.ok(revoked.revokedAt)
  assert.equal((await moderation.execute({mapId:'query-map',action:'listBans',status:'active'},context)).total,0)
  await store.updateAuthorization({mapId:'query-map',keyId:queryKey.id,permissions:['players.ban']},owner.id)
  await assert.rejects(moderation.execute({mapId:'query-map',action:'listBans'},context),/不允许查询处罚/)
  await store.revoke(queryKey.id,owner.id)

  await store.revoke(globalKey.id, owner.id)
  await assert.rejects(
    store.updateAuthorization({ mapId: 'server-map', keyId: globalKey.id }, owner.id),
    /已撤销/,
  )
  await assert.rejects(moderation.execute({ ...input, mapId:'no-grant-map',action:'getPlayerStatus' }, context), {moderationStatus:'MODERATION_GRANT_REQUIRED',status:403})
  await pool.query(`UPDATE ${table('script_admin_keys')} SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`, [key.id])
  await assert.rejects(moderation.execute({ ...input, action:'getPlayerStatus' }, context), {moderationStatus:'MODERATION_GRANT_EXPIRED',status:403})
  await store.revoke(key.id, owner.id)
  await assert.rejects(
    moderation.execute({ ...input, action: 'getPlayerStatus' }, context),
    {moderationStatus:'MODERATION_GRANT_REVOKED',status:403},
  )
  console.log(
    'Map group authorizations passed: script updates retain grants, renewal, permissions, legacy isolation, removed login flag, map/global/IP/device/permanent bans, device admission across accounts, revocation, punishment queries, explicit read grants and transaction audit',
  )
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
