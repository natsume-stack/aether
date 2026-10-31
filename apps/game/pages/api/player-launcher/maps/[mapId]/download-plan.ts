import type { NextApiRequest, NextApiResponse } from 'next'

import { PlayerAuthenticationRequiredError, requestPlayerServiceIp, resolvePlayerServiceIdentity } from '../../../../../server/player-service-client'
import { getPlayerLauncherWorlds } from '../../../../../server/player-launcher-worlds'
import { createPlayerLauncherDownloadTicket, getPlayerLauncherPackageDescriptor } from '../../../../../server/player-launcher-map-packages'

export function createPlayerLauncherDownloadPlanHandler(dependencies = {
  getWorlds: getPlayerLauncherWorlds,
  getDescriptor: getPlayerLauncherPackageDescriptor,
  resolveIdentity: resolvePlayerServiceIdentity,
  getPlayerIp: requestPlayerServiceIp,
}) {
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store')
    if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end()
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).end()
    }
    let identity
    try { ({ identity } = await dependencies.resolveIdentity(req, res, dependencies.getPlayerIp(req))) } catch (error) {
      if (error instanceof PlayerAuthenticationRequiredError) return res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录后准备地图资源' })
      return res.status(503).json({ message: '暂时无法验证玩家登录状态' })
    }
    const mapId = Array.isArray(req.query.mapId) ? req.query.mapId[0] : req.query.mapId
    const world = mapId && dependencies.getWorlds().find((entry) => entry.id === mapId || entry.publicId === mapId)
    if (!world) return res.status(404).json({ message: '地图不存在或当前账号无权游玩' })
    try {
      const descriptor = dependencies.getDescriptor(world.id)
      const download = createPlayerLauncherDownloadTicket({
        subjectId: identity.subjectId,
        permanentMapId: descriptor.permanentMapId,
        manifestDigest: descriptor.manifestDigest,
      })
      return res.status(200).json({
        permanentMapId: descriptor.permanentMapId,
        manifestDigest: descriptor.manifestDigest,
        ...download,
      })
    } catch (error) {
      return res.status(503).json({ message: (error as Error).message || '无法准备地图下载' })
    }
  }
}

export default createPlayerLauncherDownloadPlanHandler()
