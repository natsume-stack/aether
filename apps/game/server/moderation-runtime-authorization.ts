import type { NextApiRequest } from 'next'
import { verifyModerationRuntimeToken } from '@box/utils/moderation-runtime-auth'

/** Cookies, browser origins and the legacy identity bearer are never moderation credentials. */
export function moderationRuntimeIdentity(req: NextApiRequest) {
  if (req.headers.origin || req.headers.cookie || req.headers['sec-fetch-site']) return null
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Moderation ')) return null
  return verifyModerationRuntimeToken(header.slice(11), process.env.BOX_MODERATION_SIGNING_SECRET || '')
}
