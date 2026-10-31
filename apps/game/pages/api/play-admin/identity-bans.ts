import type { NextApiRequest, NextApiResponse } from 'next';

import {
  listIdentityBans,
  revokeIdentityBanGlobally,
} from '../../../server/local-player-identity';
import { authorizePlayerAdmin } from '../../../server/player-admin-authorization';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  try {
    if (req.method === 'GET') {
      if (!await authorizePlayerAdmin(req, res, 'identity-bans.view')) return;
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const kind = req.query.kind === 'ip' || req.query.kind === 'device' ? req.query.kind : 'all';
      return res.status(200).json(await listIdentityBans({
        search,
        kind,
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.pageSize || 30),
      }));
    }
    if (req.method === 'POST') {
      const context = await authorizePlayerAdmin(req, res, 'identity-bans.manage');
      if (!context) return;
      const banId = typeof req.body?.banId === 'string' || typeof req.body?.banId === 'number'
        ? req.body.banId : '';
      return res.status(200).json(await revokeIdentityBanGlobally(banId, context));
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
