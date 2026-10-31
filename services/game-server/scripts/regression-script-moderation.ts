import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {issueModerationRuntimeToken} from '@box/utils/moderation-runtime-auth'
import { moderationErrorCodes, moderationError, normalizeModerationError, moderationValidationError } from '@box/schema/api/js/moderation-error'
import { ModerationHost } from '../src/moderation/moderation-host'
import { ModerationScript } from '../src/moderation/moderation-script'
import { ModerationMetadataReporter } from '../src/moderation/moderation-metadata'

async function main() {
  assert.equal(new Set(Object.values(moderationErrorCodes)).size, Object.keys(moderationErrorCodes).length)
  for (const [status, code] of Object.entries(moderationErrorCodes)) {
    assert.deepEqual(normalizeModerationError({status, code:400, msg:'test'}), {status, code, msg:'test'})
  }
  assert.notEqual(moderationValidationError([{path:['reason']}]).code, moderationValidationError([{path:['durationSeconds']}]).code)
  assert.equal(moderationError(400, 'test').code, 41000)

  process.env.BOX_PLAYER_SERVICE_INTERNAL_URL = 'http://test-player-service'
  process.env.PERMISSION_TOKEN_SECRET = 'test-only-host-secret'
  process.env.BOX_WORLD_PERMANENT_MAP_ID = 'test-permanent-map'
  process.env.MODE = 'play'
  process.env.BOX_SERVER_NAME = '真正的地图名称'
  process.env.BOX_WORLD_DESCRIPTION = '地图介绍'
  process.env.BOX_WORLD_PUBLIC_ID = 'test-access-id'
  process.env.BOX_WORLD_VERSION = 'v1.2.3'
  const credentialRoot=fs.mkdtempSync(path.join(os.tmpdir(),'moderation-bridge-test-'))
  process.env.BOX_MODERATION_CREDENTIAL_PATH=path.join(credentialRoot,'credential')
  const token=issueModerationRuntimeToken({mapId:'test-permanent-map',runtimeId:'test-permanent-map',mode:'play'},'test-only-moderation-signing-secret')
  fs.writeFileSync(process.env.BOX_MODERATION_CREDENTIAL_PATH,token,{mode:0o600})
  let hostHandler: any
  let requestCount = 0
  let lastBody: any
  let responseError: { code: number; body: unknown } | undefined
  global.fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input)
    assert.equal(request.headers.get('Authorization'), `Moderation ${token}`)
    lastBody = await request.json()
    requestCount++
    if (responseError) return new Response(JSON.stringify(responseError.body), {status: responseError.code, headers: {'Content-Type':'application/json'}})
    return new Response(JSON.stringify({ id: 'test-ban', scope: 'map', expiresAt: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const replies: any[] = []
  const kicked: number[] = []
  new ModerationHost(
    {
      protocol: () => ({
        configure: (handlers: any) => {
          hostHandler = handlers.message.request
        },
      }),
    } as never,
    (session) => session === 'active-script',
    (id) => (id === 7 ? { userId: '42', ipAddress: '192.0.2.8', deviceHash: 'a'.repeat(64) } : undefined),
    (id) => kicked.push(id),
  )
  const client = { sessionId: 'active-script', message: { reply: (reply: any) => replies.push(reply) } }
  const command = { action: 'banCurrentIP', reason: 'test', durationSeconds: 60, requestId: 'test-ip' }
  await hostHandler(client, { handle: 1, playerId: 7, payload: JSON.stringify(command) })
  assert.equal(requestCount, 1)
  await hostHandler(client, { handle: 9, playerId: 7, payload: JSON.stringify({...command, durationSeconds: 0}) })
  assert.equal(lastBody.durationSeconds, 0)
  await hostHandler(client, {handle:11,playerId:7,payload:JSON.stringify({...command,durationSeconds:'0'})})
  assert.deepEqual(JSON.parse(replies.at(-1).payload), {status:'MODERATION_DURATION_INVALID',code:41007,msg:'durationSeconds 必须为数字整数（0–604800）；永久封禁请传数字 0，不要加引号'})
  assert.equal(lastBody.durationSeconds, 0, 'invalid string must not reach the service')
  requestCount = 1

  const commandBody = lastBody
  process.env.SERVER_ID = 'private-room'
  await new ModerationMetadataReporter(() => ({ name: 'private' })).refresh()
  assert.equal(requestCount, 1, 'private rooms must not replace public metadata')
  process.env.SERVER_ID = 'test-permanent-map'
  await new ModerationMetadataReporter(() => ({ name: 'public' })).refresh()
  assert.equal(requestCount, 2)
  assert.equal(lastBody.mode, 'play')
  assert.equal(lastBody.name, '真正的地图名称')
  assert.equal(lastBody.description, '地图介绍')
  assert.equal(lastBody.projectId, 'test-permanent-map')
  assert.equal(lastBody.publicId, 'test-access-id')
  assert.equal(lastBody.version, 'v1.2.3')
  assert.equal('scriptFingerprint' in lastBody, false)
  requestCount = 1
  lastBody = commandBody
  assert.equal(lastBody.userId, '42')
  assert.equal(lastBody.ipAddress, '192.0.2.8')
  assert.equal(lastBody.mapId, 'test-permanent-map')
  assert.equal('scriptFingerprint' in lastBody, false)
  assert.deepEqual(kicked, [7, 7])
  for (const field of ['mapId', 'scriptFingerprint', 'userId', 'ipAddress', 'deviceHash', 'keyId', 'adminId']) {
    await hostHandler(client, { handle: 2, playerId: 7, payload: JSON.stringify({ ...command, [field]: 'forged' }) })
    assert.equal(replies.at(-1).success, false)
  }
  await hostHandler(client, { handle: 3, playerId: 99, payload: JSON.stringify(command) })
  assert.equal(replies.at(-1).success, false)
  assert.equal(requestCount, 1)
  await hostHandler(
    { ...client, sessionId: 'obsolete-script' },
    { handle: 4, playerId: 7, payload: JSON.stringify(command) },
  )
  assert.equal(requestCount, 1)

  await hostHandler(client, { handle: 10, playerId: 7, payload: JSON.stringify({ ...command, action: 'banCurrentDevice' }) })
  assert.equal(lastBody.deviceHash, 'a'.repeat(64))
  assert.equal(lastBody.ipAddress, undefined)
  assert.equal(replies.at(-1).success, true)
  assert.deepEqual(kicked, [7, 7, 7])

  const invalidTargetScript = new ModerationScript({protocol:()=>({configure:()=>{},server:{message:{request:()=>assert.fail('invalid target sent')}}})} as never,
    f=>f(), ()=>{throw new Error('目标不是当前地图的玩家')}, {setTimeout:()=>1,clearTimeout:()=>{}})
  await assert.rejects(invalidTargetScript.banPlayer({} as never, {reason:'test',durationSeconds:60}), {status:'MODERATION_TARGET_INVALID',code:41002,msg:'目标不是当前地图的玩家'})
  await assert.rejects(invalidTargetScript.banPlayer(Array(101).fill({}), {reason:'test',durationSeconds:60}), {status:'MODERATION_BATCH_TOO_LARGE',code:41004})
  await assert.rejects(invalidTargetScript.banPlayer([], {reason:'test',durationSeconds:60,requestId:'?'}), {status:'MODERATION_REQUEST_ID_INVALID',code:41005})
  let scriptHandler: any
  const sent: any[] = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const script = new ModerationScript(
    {
      protocol: () => ({
        configure: (handlers: any) => {
          scriptHandler = handlers.message.reply
        },
        server: { message: { request: (msg: any) => sent.push(msg) } },
      }),
    } as never,
    (event) => event(),
    () => 7,
    {
      setTimeout: (fn) => {
        timers.set(++timerId, fn)
        return timerId
      },
      clearTimeout: (id) => {
        timers.delete(id)
      },
    },
  )
  const player = {} as never
  assert.equal('mapId' in script, false)
  assert.equal('scriptFingerprint' in script, false)
  const promise = script.banPlayer(player, { reason: 'test', durationSeconds: 60, requestId: 'test-account' })
  assert.equal(sent[0].playerId, 7)
  assert.equal(JSON.parse(sent[0].payload).scope, 'server')
  assert.ok(!sent[0].payload.includes('secret'))
  scriptHandler({
    handle: sent[0].handle,
    success: true,
    payload: JSON.stringify({ id: 'ban', scope: 'map', expiresAt: 'expiry' }),
  })
  assert.deepEqual(await promise, { id: 'ban', expiresAt: 'expiry' })
  assert.equal(timers.size, 0)
  const batch = script.banCurrentDevice([player, player, player], { reason: 'batch', durationSeconds: 0, requestId: 'device-batch' })
  const batchIds: string[] = []
  for (let index = 0; index < 3; index++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    const message = sent.at(-1)
    const body = JSON.parse(message.payload)
    assert.equal(body.action, 'banCurrentDevice')
    assert.equal(body.scope, 'server')
    batchIds.push(body.requestId)
    scriptHandler({ handle: message.handle, success: index !== 1, payload: JSON.stringify(index === 1 ? {status:'MODERATION_FORBIDDEN',code:41300,msg:'权限不足'} : {id: `device-${index}`,scope:'map',expiresAt:null}) })
  }
  assert.deepEqual(batchIds, ['device-batch.b0', 'device-batch.b1', 'device-batch.b2'])
  assert.deepEqual(await batch, [
    {index:0,success:true,ban:{id:'device-0',expiresAt:null}},
    {index:1,success:false,error:{status:'MODERATION_FORBIDDEN',code:41300,msg:'权限不足'}},
    {index:2,success:true,ban:{id:'device-2',expiresAt:null}},
  ])
  const sentCount = sent.length
  await assert.rejects(script.banPlayer(Array(101).fill(player), {reason:'test',durationSeconds:60,requestId:'invalid'}), (error: any) => error.status === 'MODERATION_BATCH_TOO_LARGE' && error.code === 41004 && /100/.test(error.msg))
  assert.equal(sent.length, sentCount)
  assert.deepEqual(await script.banPlayer([], {reason:'test',durationSeconds:60,requestId:'empty'}), [])
  const automaticIds: string[] = []
  const automaticOptions = {reason:'automatic',durationSeconds:60}
  for (const invoke of [
    () => script.banPlayer(player, automaticOptions),
    () => script.banCurrentIP(player, automaticOptions),
    () => script.revokeBan('ban', {reason:'review'}),
  ]) {
    const result = invoke()
    const request = sent.at(-1)
    const id = JSON.parse(request.payload).requestId
    assert.match(id, /^[A-Za-z0-9._-]{1,72}$/)
    automaticIds.push(id)
    scriptHandler({handle:request.handle,success:true,payload:JSON.stringify({id:'ban',revoked:true,scope:'map',expiresAt:null})})
    await result
  }
  assert.equal(new Set(automaticIds).size, automaticIds.length)
  assert.equal('requestId' in automaticOptions, false)
  const automaticBatch = script.banCurrentDevice([player, player], automaticOptions)
  const automaticBatchIds: string[] = []
  for (let index = 0; index < 2; index++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    const request = sent.at(-1)
    automaticBatchIds.push(JSON.parse(request.payload).requestId)
    scriptHandler({handle:request.handle,success:true,payload:JSON.stringify({id:`auto-${index}`,scope:'map',expiresAt:null})})
  }
  assert.equal((await automaticBatch).length, 2)
  assert.equal(automaticBatchIds[0].replace(/\.b0$/, ''), automaticBatchIds[1].replace(/\.b1$/, ''))
  assert.ok(!automaticIds.includes(automaticBatchIds[0].replace(/\.b0$/, '')))
  const list = script.listBans({player,kind:'device',status:'active',page:2,pageSize:10})
  let msg=sent.at(-1)
  assert.equal(msg.playerId,7)
  assert.deepEqual(JSON.parse(msg.payload),{kind:'device',status:'active',page:2,pageSize:10,action:'listBans'})
  scriptHandler({handle:msg.handle,success:true,payload:JSON.stringify({items:[],total:0,page:2,pageSize:10})})
  assert.equal((await list).page,2)
  const detailsPromise = script.getBan('record-with-scope')
  msg = sent.at(-1)
  scriptHandler({handle:msg.handle,success:true,payload:JSON.stringify({ban:{id:'record',scope:'map',expiresAt:null,reason:'legacy'}})})
  assert.equal('scope' in (await detailsPromise)!, false)
  const recordsPromise = script.listBans()
  msg = sent.at(-1)
  scriptHandler({handle:msg.handle,success:true,payload:JSON.stringify({items:[{id:'record',scope:'map',expiresAt:null}],total:1,page:1,pageSize:20})})
  assert.equal('scope' in (await recordsPromise).items[0], false)
  const statusPromise = script.getPlayerStatus(player)
  msg = sent.at(-1)
  scriptHandler({handle:msg.handle,success:true,payload:JSON.stringify({status:'active',bans:[{id:'record',scope:'map',expiresAt:null}]})})
  assert.equal('scope' in (await statusPromise).bans[0], false)
  const get = script.getBan('00000000-0000-0000-0000-000000000000')
  msg=sent.at(-1)
  assert.equal(msg.playerId,0)
  scriptHandler({handle:msg.handle,success:true,payload:JSON.stringify({ban:null})})
  assert.equal(await get,null)
  await hostHandler(client,{handle:11,playerId:0,payload:JSON.stringify({action:'listBans',page:1})})
  assert.equal(replies.at(-1).success,true)
  assert.equal(lastBody.userId,undefined)
  await hostHandler(client,{handle:12,playerId:0,payload:JSON.stringify({action:'getBan',banId:'00000000-0000-0000-0000-000000000000'})})
  assert.equal(replies.at(-1).success,true)
  await hostHandler(client,{handle:13,playerId:99,payload:JSON.stringify({action:'listBans'})})
  assert.equal(replies.at(-1).success,false)
  await hostHandler(client,{handle:14,playerId:0,payload:JSON.stringify({action:'listBans',pageSize:51})})
  assert.equal(replies.at(-1).success,false)
  const pending = Array.from({ length: 8 }, () => script.getPlayerStatus(player))
  const outcomes = Promise.allSettled(pending)
  await assert.rejects(script.getPlayerStatus(player), {status:'MODERATION_RATE_LIMITED',code:42900,msg:'地图管理请求过多'})
  for (const fn of timers.values()) fn()
  assert.ok((await outcomes).every((result) => result.status === 'rejected' && result.reason.status === 'MODERATION_TIMEOUT' && result.reason.code === 45006))
  const denied = script.banPlayer(player, automaticOptions)
  msg = sent.at(-1)
  scriptHandler({handle:msg.handle,success:false,payload:JSON.stringify({status:'MODERATION_FORBIDDEN',code:41300,msg:'授权不允许此操作'})})
  await assert.rejects(denied, {status:'MODERATION_FORBIDDEN',code:41300,msg:'授权不允许此操作'})
  const malformed = script.getPlayerStatus(player)
  msg = sent.at(-1)
  scriptHandler({handle:msg.handle,success:false,payload:'invalid-json'})
  await assert.rejects(malformed, {status:'MODERATION_RESPONSE_INVALID',code:45002,msg:'地图管理响应无效'})
  await assert.rejects(script.banPlayer(player, {reason:'x'.repeat(2200),durationSeconds:60}), {status:'MODERATION_PAYLOAD_TOO_LARGE',code:41003,msg:'地图管理参数过长'})
  await assert.rejects(script.banPlayer(player, null as never), {status:'MODERATION_OPTIONS_INVALID',code:41001,msg:'地图管理参数无效'})
  for (const body of [
    {status:'MODERATION_FORBIDDEN',code:41300,msg:'授权不允许此操作'},
    {message:'授权不允许此操作'},
  ]) {
    responseError = {code:403,body}
    await hostHandler(client,{handle:15,playerId:7,payload:JSON.stringify(command)})
    assert.deepEqual(JSON.parse(replies.at(-1).payload), {status:'MODERATION_FORBIDDEN',code:41300,msg:'授权不允许此操作'})
  }
  responseError = undefined
  await hostHandler(client,{handle:16,playerId:99,payload:JSON.stringify(command)})
  assert.deepEqual(JSON.parse(replies.at(-1).payload), {status:'MODERATION_PLAYER_OFFLINE',code:41401,msg:'目标玩家已离线'})
  await hostHandler(client,{handle:17,playerId:7,payload:'bad-json'})
  assert.deepEqual(JSON.parse(replies.at(-1).payload), {status:'MODERATION_PARAMS_INVALID',code:41000,msg:'地图管理参数无效'})
  console.log(
    'Script moderation bridge passed: trusted target/map/IP, stale peer rejection, tamper rejection, bounded requests, promise completion and timeout',
  )
  fs.rmSync(credentialRoot,{recursive:true,force:true})
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
