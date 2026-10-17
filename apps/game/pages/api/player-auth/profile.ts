import type { NextApiRequest, NextApiResponse } from 'next';
import { handlePlayerSelfService } from '../../../server/player-self-service-handler';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handlePlayerSelfService(req, res, 'profile');
}
