import type { NextApiRequest, NextApiResponse } from 'next'

import { getPlayResourceSigningIdentity } from '../../../server/play-resource-cache'

function playerLoginApiUrl() {
  try {
    const configured = new URL(String(process.env.BOX_PLAYER_LOGIN_URL || '').trim())
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password) return ''
    return new URL(`${configured.pathname.replace(/\/$/, '')}/api/auth/login`, configured.origin).toString()
  } catch {
    return ''
  }
}

/** Safe, unauthenticated handshake: disclose no maps or resource URLs here. */
export function createPlayerLauncherBootstrapHandler(
  readSigningIdentity: typeof getPlayResourceSigningIdentity = getPlayResourceSigningIdentity,
) {
  return function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store')
    if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end()
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).end()
    }
    try {
      return res.status(200).json({
        protocolVersion: 1,
        serverName: String(process.env.BOX_PLAYER_LAUNCHER_SERVER_NAME || '').trim(),
        loginRequired: true,
        loginApiUrl: playerLoginApiUrl(),
        signingKey: readSigningIdentity(),
      })
    } catch {
      return res.status(503).json({ message: '无法读取玩家启动器支持信息' })
    }
  }
}

export default createPlayerLauncherBootstrapHandler()
