import type { NextApiRequest, NextApiResponse } from 'next'

import { requestPlayerServiceIp, resolvePlayerServiceIdentity, PlayerAuthenticationRequiredError } from '../../../server/player-service-client'
import { getPlayerLauncherWorlds } from '../../../server/player-launcher-worlds'
import { getPlayWorlds } from '../../../server/play-worlds'
import { getPlayPresenceCounts } from '../../../server/play-presence'

const defaultDependencies = {
  getWorlds: getPlayerLauncherWorlds,
  getAllWorlds: getPlayWorlds,
  getPresenceCounts: getPlayPresenceCounts,
  resolveIdentity: resolvePlayerServiceIdentity,
  getPlayerIp: requestPlayerServiceIp,
}

export function createPlayerLauncherMapsHandler(overrides: Partial<typeof defaultDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides }
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
      if (error instanceof PlayerAuthenticationRequiredError) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录后查看可游玩的地图' })
      }
      return res.status(503).json({ message: '暂时无法验证玩家登录状态' })
    }

    const worlds = dependencies.getWorlds()
    const groupByMap = Object.fromEntries(
      dependencies.getAllWorlds().map((world) => [
        world.publicId,
        world.mapGroupId || world.mainProjectId || world.id,
      ]),
    )
    const onlineCounts = dependencies.getPresenceCounts(worlds.map((world) => world.publicId), groupByMap)
    return res.status(200).json({
      worlds: worlds.map(({ id, permanentMapId, publicId, name, author, description, cover, loadingCover, version }) => ({
        id,
        permanentMapId,
        publicId,
        name,
        author,
        description,
        cover,
        loadingCover,
        version,
        onlineCount: onlineCounts[publicId]?.onlineCount || 0,
      })),
    })
  }
}

export default createPlayerLauncherMapsHandler()
