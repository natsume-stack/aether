import type { NextApiRequest, NextApiResponse } from 'next'
import { isInternalIdentityRequest, logoutPlayer } from '../../../server/local-player-identity'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }
  if (!isInternalIdentityRequest(req)) return res.status(401).json({ message: '玩家身份服务内部鉴权失败' })
  await logoutPlayer(req, res)
  return res.status(204).end()
}
