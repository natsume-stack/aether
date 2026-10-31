import type { NextApiRequest, NextApiResponse } from 'next'
import { findPlayWorld, getPlayWorlds } from '../../server/play-worlds'
import { getPlayPresenceCounts, removePlayPresence, touchPlayPresence } from '../../server/play-presence'
import { requestPlayerServiceIp, resolvePlayerServiceIdentity } from '../../server/player-service-client'

function mapReference(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : ''
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    const maps = String(req.query.maps || '').split(',').map(mapReference).filter(Boolean).slice(0, 100)
    const groupByMap = Object.fromEntries(
      getPlayWorlds().map((world) => [
        world.publicId,
        world.mapGroupId || world.mainProjectId || world.id,
      ]),
    )
    return res.status(200).json({ maps: getPlayPresenceCounts(maps, groupByMap) })
  }
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end()
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, POST, DELETE')
    return res.status(405).end()
  }
  const reference = mapReference(req.body?.mapId)
  const world = reference ? findPlayWorld(reference) : undefined
  if (!world) return res.status(404).json({ message: '地图不存在' })
  try {
    const { identity } = await resolvePlayerServiceIdentity(req, res, requestPlayerServiceIp(req))
    if (req.method === 'DELETE') removePlayPresence(world.publicId, identity.subjectId)
    else touchPlayPresence(world.publicId, identity.subjectId)
    return res.status(204).end()
  } catch {
    return res.status(401).json({ message: '需要登录后才能游玩' })
  }
}
