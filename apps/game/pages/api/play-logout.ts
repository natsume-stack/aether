import type { NextApiRequest, NextApiResponse } from 'next'
import { requestPlayerServiceIp } from '../../server/player-service-client'

function internalURL() {
  const value = (process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').trim()
  if (!value) throw new Error('玩家身份服务未配置')
  return value.replace(/\/$/, '')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end()
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }
  try {
    const response = await fetch(`${internalURL()}/api/player-internal/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PERMISSION_TOKEN_SECRET || ''}`,
        Cookie: String(req.headers.cookie || ''),
        'X-Box-Player-IP': requestPlayerServiceIp(req),
        'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
      },
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) res.setHeader('Set-Cookie', setCookie)
    return res.status(response.status).end()
  } catch (error) {
    return res.status(503).json({ message: (error as Error).message })
  }
}
