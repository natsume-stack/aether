import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createManagedPlayer,
  listManagedPlayers,
} from '../../../../server/local-player-identity';
import { authorizePlayerAdmin } from '../../../../server/player-admin-authorization';
import {
  parseCreateManagedPlayer,
  parsePlayerListQuery,
} from '../../../../server/player-admin-validation';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  try {
    if (req.method === 'POST') {
      const context = await authorizePlayerAdmin(req, res, 'players.create');
      if (!context) return;
      const input = parseCreateManagedPlayer(req.body);
      return res.status(201).json({
        player: await createManagedPlayer(
          { ...input, role: 'player', adminPermissions: [] },
          context,
        ),
      });
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).end();
    }
    const requirement = req.query.online === 'online'
      ? 'sessions.view'
      : req.query.identity === 'banned'
        ? 'account-bans.view'
        : 'players.view';
    if (!await authorizePlayerAdmin(req, res, requirement)) return;
    return res.status(200).json(
      await listManagedPlayers(parsePlayerListQuery(req.query)),
    );
  } catch (error) {
    return res.status(req.method === 'POST' ? 400 : 503).json({ message: (error as Error).message });
  }
}
