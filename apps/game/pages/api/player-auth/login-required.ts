import type { NextApiRequest, NextApiResponse } from 'next';

import {
  PlayerLoginURLNotConfiguredError,
  requirePlayerLoginURL,
} from '../../../server/player-service-client';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  const source = (Array.isArray(req.query.source) ? req.query.source[0] : req.query.source) === 'creator'
    ? 'creator'
    : 'play';
  try {
    return res.redirect(307, requirePlayerLoginURL(source));
  } catch (error) {
    if (error instanceof PlayerLoginURLNotConfiguredError) {
      return res.status(503).json({ code: error.code, message: error.message });
    }
    return res.status(500).json({ message: (error as Error).message });
  }
}
