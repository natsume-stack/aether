import { playerBanResponse } from '../../../server/player-ban-response';
import type { NextApiRequest, NextApiResponse } from 'next';
import { currentPlayer } from '../../../server/local-player-identity';
import { authorizePlayerAuthRequest } from '../../../server/player-auth-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!authorizePlayerAuthRequest(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).end();
  }
  try {
    return res.status(200).json(await currentPlayer(req, res));
  } catch (error) {
    const ban = playerBanResponse(error);
    if (ban) return res.status(403).json(ban);
    const message = (error as Error).message;
    return res.status(503).json({ message });
  }
}
