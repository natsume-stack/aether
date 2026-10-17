import type { NextApiRequest, NextApiResponse } from 'next'

import {
  getPlayResourceCacheManifest,
} from '../../../server/play-resource-cache'

/** Public, non-sensitive static-resource manifest consumed by the Play loader. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end()
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).end()
  }
  res.setHeader('Cache-Control', 'no-store')
  try {
    const manifest = getPlayResourceCacheManifest(String(req.query.world || ''))
    return res.status(200).json(manifest)
  } catch (error) {
    return res.status(404).json({ message: (error as Error).message })
  }
}
