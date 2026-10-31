import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'
import { moderationRuntimeIdentity } from '../../../server/moderation-runtime-authorization'
import { scriptModerationService } from '../../../server/script-moderation-service'
import { mapIdSchema } from '../../../server/script-moderation-store'
import { sendPlayerAdminApiError, applyPlayerAdminSecurityHeaders } from '../../../server/player-admin-authorization'

const playerSchema = z.object({ userId: z.string().max(128), ipAddress: z.string().max(64), deviceHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict()
const bodySchema = z.union([
  playerSchema.extend({ mapId: mapIdSchema }).strict(),
  z.object({ mapId: mapIdSchema, players: z.array(playerSchema).min(1).max(100) }).strict(),
])
export const config = { api: { bodyParser: { sizeLimit: '24kb' } } }
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  applyPlayerAdminSecurityHeaders(res)
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }
  const runtime = moderationRuntimeIdentity(req)
  if (!runtime) return res.status(401).json({ message: '地图实例鉴权失败' })
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: '地图准入参数无效' })
  if (runtime.mapId !== parsed.data.mapId || runtime.mode !== 'play')
    return res.status(403).json({ message: '地图实例权限范围不匹配' })
  try {
    const input = parsed.data
    if ('players' in input)
      return res.status(200).json({ denied: await scriptModerationService.deniedPlayers(input.mapId, input.players) })
    return res.status(200).json(await scriptModerationService.admission(input.mapId, input.userId, input.ipAddress, input.deviceHash))
  } catch (error) {
    return sendPlayerAdminApiError(res, error, 'Map admission failed')
  }
}
