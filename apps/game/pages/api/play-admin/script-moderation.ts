import { z } from 'zod'
import { playerAdminRoute } from '../../../server/player-admin-route'
import {
  scriptModerationStore,
  keyCreateSchema,
  bindingSchema,
  moderationPermissionsSchema,
  mapIdSchema,
} from '../../../server/script-moderation-store'

const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), values: keyCreateSchema }).strict(),
  z.object({ action: z.literal('bind'), values: bindingSchema }).strict(),
  z
    .object({
      action: z.literal('update'),
      values: bindingSchema.extend({ days: z.number().int().min(1).max(360).optional(), maximumBanSeconds: z.union([z.literal(0), z.number().int().min(60).max(604800)]).optional(), scope: z.enum(['map', 'server']).optional(), permissions: moderationPermissionsSchema.optional() }).strict(),
    })
    .strict(),
  z.object({ action: z.literal('revoke'), keyId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('unbind'), mapId: mapIdSchema, mode: z.enum(['edit', 'play']).default('play') }).strict(),
  z.object({ action: z.literal('revoke-map-ban'), banId: z.string().uuid() }).strict(),
])
export const config = { api: { bodyParser: { sizeLimit: '16kb' } } }
export default playerAdminRoute(
  {
    methods: ['GET', 'POST'],
    requirement: 'owner',
    errorContext: 'Script moderation authorization failed',
  },
  async ({ req, res, actor }) => {
    if (req.method === 'GET') return res.status(200).json(await scriptModerationStore.list())
    const parsed = operationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ message: '地图授权参数无效' })
    const op = parsed.data
    const result =
      op.action === 'create'
        ? await scriptModerationStore.create(op.values, actor.subjectId, actor)
        : op.action === 'bind'
          ? await scriptModerationStore.bind(op.values, actor.subjectId, actor)
          : op.action === 'update'
            ? await scriptModerationStore.updateAuthorization(op.values, actor.subjectId, actor)
            : op.action === 'revoke'
              ? await scriptModerationStore.revoke(op.keyId, actor.subjectId, actor)
              : op.action === 'revoke-map-ban'
                ? await scriptModerationStore.revokeMapBan(op.banId, actor.subjectId, actor)
                : await scriptModerationStore.unbind(op.mapId, actor.subjectId, op.mode, actor)
    return res.status(200).json(result)
  },
)
