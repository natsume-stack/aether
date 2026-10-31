import type { NextApiRequest, NextApiResponse } from 'next'
import { proxyPlayerProfile } from '../../server/player-profile-proxy'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return proxyPlayerProfile(req, res, 'play')
}
