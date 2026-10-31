import type { NextApiRequest, NextApiResponse } from 'next';

import { checkPlayerDatabaseReady } from '../../server/local-player-identity';

export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (process.env.BOX_DEPLOYMENT_MODE === 'player-service') {
    try {
      await checkPlayerDatabaseReady();
    } catch (error) {
      return res.status(503).json({
        status: 'error',
        runtime: 'not-ready',
        message: (error as Error).message,
      });
    }
  }
  return res.status(200).json({ status: 'ok', runtime: 'ready' });
};
