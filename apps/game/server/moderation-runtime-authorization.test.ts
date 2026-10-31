import { describe, test, expect, jest } from '@jest/globals'
import { issueModerationRuntimeToken } from '@box/utils/moderation-runtime-auth'
import { moderationRuntimeIdentity } from './moderation-runtime-authorization'
import type { NextApiRequest } from 'next'
import type {NextApiResponse} from 'next'
import moderationHandler from '../pages/api/player-internal/script-moderation'
import { scriptModerationService } from './script-moderation-service'
import metadataHandler from '../pages/api/player-internal/script-metadata'
import { ScriptModerationRequestError } from './script-moderation-error'

describe('moderation runtime authorization', () => {
  const secret = 'test-only-moderation-signing-secret'
  test('moderation HTTP errors use CommonError without losing the permission description', async () => {
    const previousSecret = process.env.BOX_MODERATION_SIGNING_SECRET
    const previousMode = process.env.BOX_DEPLOYMENT_MODE
    process.env.BOX_MODERATION_SIGNING_SECRET = secret
    process.env.BOX_DEPLOYMENT_MODE = 'player-service'
    const token = issueModerationRuntimeToken({mapId:'test-map',runtimeId:'test-map',mode:'play'},secret)
    const call = async (headers: Record<string,string>, body: unknown) => {
      let code = 0, payload: unknown
      const res = {setHeader:()=>{},status:(value:number)=>{code=value;return res},json:(value:unknown)=>{payload=value;return res},end:()=>res}
      await moderationHandler({method:'POST',headers,socket:{remoteAddress:'127.0.0.1'},body} as NextApiRequest,res as unknown as NextApiResponse)
      return {code,payload}
    }
    try {
      expect(await call({},{})).toEqual({code:401,payload:{status:'MODERATION_AUTH_REQUIRED',code:41100,msg:'地图实例鉴权失败'}})
      expect(await call({authorization:`Moderation ${token}`},{mapId:'test-map'})).toEqual({code:400,payload:{status:'MODERATION_ACTION_INVALID',code:41010,msg:'地图管理操作无效'}})
      expect(await call({authorization:`Moderation ${token}`},{mapId:'test-map',action:'banPlayer',reason:'test',durationSeconds:-1})).toEqual({code:400,payload:{status:'MODERATION_DURATION_INVALID',code:41007,msg:'durationSeconds 必须为数字整数（0–604800）；永久封禁请传数字 0，不要加引号'}})
      expect(await call({authorization:`Moderation ${token}`},{mapId:'test-map',action:'banPlayer',reason:''})).toEqual({code:400,payload:{status:'MODERATION_REASON_INVALID',code:41006,msg:'处罚原因须为 1–500 个字符'}})
      const execute = jest.spyOn(scriptModerationService,'execute').mockRejectedValue(new ScriptModerationRequestError('授权不允许此操作','MODERATION_ACTION_FORBIDDEN',403))
      try {
        expect(await call({authorization:`Moderation ${token}`},{mapId:'test-map',action:'getPlayerStatus',userId:'1'})).toEqual({code:403,payload:{status:'MODERATION_ACTION_FORBIDDEN',code:41305,msg:'授权不允许此操作'}})
        for (const [status, code, msg] of [
          ['MODERATION_GRANT_REQUIRED',41311,'地图未授权'],
          ['MODERATION_GRANT_EXPIRED',41312,'地图授权已过期'],
          ['MODERATION_GRANT_REVOKED',41313,'地图授权已撤销'],
        ] as const) {
          execute.mockRejectedValue(new ScriptModerationRequestError(msg,status,403))
          expect(await call({authorization:`Moderation ${token}`},{mapId:'test-map',action:'getPlayerStatus',userId:'1'})).toEqual({code:403,payload:{status,code,msg}})
        }
      } finally {execute.mockRestore()}
    } finally {
      if (previousSecret === undefined) delete process.env.BOX_MODERATION_SIGNING_SECRET
      else process.env.BOX_MODERATION_SIGNING_SECRET = previousSecret
      if (previousMode === undefined) delete process.env.BOX_DEPLOYMENT_MODE
      else process.env.BOX_DEPLOYMENT_MODE = previousMode
    }
  })
  test('browser cookies/origins and the legacy identity bearer are rejected', () => {
    const previous = process.env.BOX_MODERATION_SIGNING_SECRET
    process.env.BOX_MODERATION_SIGNING_SECRET = secret
    const token = issueModerationRuntimeToken({ mapId: 'test-map', runtimeId: 'test-map', mode: 'play' }, secret)
      const request = (headers: Record<string, string | undefined>) => ({ headers }) as NextApiRequest
    try {
      expect(moderationRuntimeIdentity(request({ authorization: `Moderation ${token}` }))?.mapId).toBe('test-map')
      expect(moderationRuntimeIdentity(request({ authorization: `Bearer ${secret}` }))).toBeNull()
      for (const headers of [
        { origin: 'http://localhost' },
        { cookie: 'box_local_admin_session=fake' },
        { 'sec-fetch-site': 'same-origin' },
      ]) {
        expect(moderationRuntimeIdentity(request({ ...headers, authorization: `Moderation ${token}` }))).toBeNull()
      }
    } finally {
      if (previous === undefined) delete process.env.BOX_MODERATION_SIGNING_SECRET
      else process.env.BOX_MODERATION_SIGNING_SECRET = previous
    }
  })
  test('runtime credentials cannot operate another map, unverified mode changes or private-room version reporting',async()=>{
    const previousSecret=process.env.BOX_MODERATION_SIGNING_SECRET,previousMode=process.env.BOX_DEPLOYMENT_MODE;
    process.env.BOX_MODERATION_SIGNING_SECRET=secret;process.env.BOX_DEPLOYMENT_MODE='player-service';
    const call=async(handler:(req:NextApiRequest,res:NextApiResponse)=>Promise<unknown>,identity:{mapId:string;runtimeId:string;mode:'edit'|'play'},body:unknown)=>{
      let status=0;const res={setHeader:()=>{},status:(value:number)=>{status=value;return res},json:()=>res,end:()=>res};
      const token=issueModerationRuntimeToken(identity,secret);
      await handler({method:'POST',headers:{authorization:`Moderation ${token}`},socket:{remoteAddress:'127.0.0.1'},body} as NextApiRequest,res as unknown as NextApiResponse);
      return status;
    };
    try{
      const command={mapId:'other-map',action:'getPlayerStatus',userId:'1'};
      expect(await call(moderationHandler,{mapId:'test-map',runtimeId:'test-map',mode:'play'},command)).toBe(403);
      const execute = jest.spyOn(scriptModerationService, 'execute').mockResolvedValue({ status: 'active', bans: [] } as never);
      try {
        expect(await call(moderationHandler,{mapId:'other-map',runtimeId:'other-map',mode:'edit'},command)).toBe(200);
        expect(execute.mock.calls[0][2]).toBe('edit');
        expect(await call(moderationHandler,{mapId:'other-map',runtimeId:'other-map',mode:'edit'},{...command, mode:'play'})).toBe(400);
      } finally { execute.mockRestore(); }
      expect(await call(metadataHandler,{mapId:'test-map',runtimeId:'private-room',mode:'play'},{mapId:'test-map',mode:'play',name:'test'})).toBe(403);
    }finally{
      if(previousSecret===undefined)delete process.env.BOX_MODERATION_SIGNING_SECRET;else process.env.BOX_MODERATION_SIGNING_SECRET=previousSecret;
      if(previousMode===undefined)delete process.env.BOX_DEPLOYMENT_MODE;else process.env.BOX_DEPLOYMENT_MODE=previousMode;
    }
  })
})
