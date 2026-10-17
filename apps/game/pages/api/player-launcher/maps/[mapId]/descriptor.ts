import type { NextApiRequest, NextApiResponse } from 'next'

import { PlayerAuthenticationRequiredError, requestPlayerServiceIp, resolvePlayerServiceIdentity } from '../../../../../server/player-service-client'
import { getPlayerLauncherWorlds } from '../../../../../server/player-launcher-worlds'
import { getPlayerLauncherPackageDescriptor } from '../../../../../server/player-launcher-map-packages'

export function createPlayerLauncherDescriptorHandler(dependencies = {
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
    try {
      await dependencies.resolveIdentity(req, res, dependencies.getPlayerIp(req))
    } catch (error) {
      if (error instanceof PlayerAuthenticationRequiredError) return res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录后获取地图资源' })
      return res.status(503).json({ message: '暂时无法验证玩家登录状态' })
    }
    const mapId = Array.isArray(req.query.mapId) ? req.query.mapId[0] : req.query.mapId
    if (!mapId || !dependencies.getWorlds().some((world) => world.id === mapId || world.publicId === mapId)) {
      return res.status(404).json({ message: '地图不存在或当前账号无权游玩' })
    }
    try {
      return res.status(200).json(await dependencies.getDescriptor(mapId))
    } catch (error) {
      return res.status(503).json({ message: (error as Error).message || '无法读取地图资源清单' })
    }
  }
}

export default createPlayerLauncherDescriptorHandler()
