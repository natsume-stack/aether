import type { NextApiRequest, NextApiResponse } from 'next'
import { isInternalIdentityRequest, updateCurrentPlayerProfile } from '../../../server/local-player-identity'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end()
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH')
    return res.status(405).end()
  }
  if (!isInternalIdentityRequest(req)) {
    return res.status(401).json({ message: '玩家身份服务内部鉴权失败' })
  }
  try {
    return res.status(200).json({ player: await updateCurrentPlayerProfile(req, res, req.body || {}) })
  } catch (error) {
    const message = (error as Error).message
    return res.status(message === 'AUTH_REQUIRED' ? 401 : 400).json({ message })
  }
}
