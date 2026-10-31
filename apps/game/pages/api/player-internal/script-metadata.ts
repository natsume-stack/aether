import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'
import { moderationRuntimeIdentity } from '../../../server/moderation-runtime-authorization'
import { scriptModerationStore, mapIdSchema } from '../../../server/script-moderation-store'
import { applyPlayerAdminSecurityHeaders, sendPlayerAdminApiError } from '../../../server/player-admin-authorization'

const schema = z
  .object({
    mapId: mapIdSchema,
    groupId: mapIdSchema.optional(),
    mode: z.enum(['edit', 'play']),
    projectId: mapIdSchema.optional(),
    publicId: z.string().max(128).optional(),
    description: z.string().max(2000).optional(),
    version: z.string().max(64).optional(),
    name: z.string().trim().min(1).max(64),
  })
  .strict()
export const config = { api: { bodyParser: { sizeLimit: '4kb' } } }
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  applyPlayerAdminSecurityHeaders(res)
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }
  const runtime = moderationRuntimeIdentity(req)
  if (!runtime) return res.status(401).json({ message: '地图实例鉴权失败' })
  const input = schema.safeParse(req.body)
  if (!input.success) return res.status(400).json({ message: '地图版本信息无效' })
  if (runtime.mapId !== input.data.mapId || runtime.mode !== input.data.mode || runtime.runtimeId !== runtime.mapId)
    return res.status(403).json({ message: '只有地图公开实例可以登记自身版本' })
  try {
    return res.status(200).json(await scriptModerationStore.observeRuntime(input.data))
  } catch (error) {
    return sendPlayerAdminApiError(res, error, 'Script metadata observation failed')
  }
}
