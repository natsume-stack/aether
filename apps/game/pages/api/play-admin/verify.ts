import type { NextApiRequest, NextApiResponse } from 'next';
import { allowPlayAdmin } from '../../../server/play-admin-security';
import { authorizePlayerAdmin } from '../../../server/player-admin-authorization';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.BOX_DEPLOYMENT_MODE === 'player-service') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).end();
    }
    const actor = await authorizePlayerAdmin(req, res, 'players.view');
    if (!actor) return;
    return res.status(200).json({
      verified: true,
      actor: {
        displayName: actor.actorDisplayName,
        username: actor.actorUsername,
        role: actor.actorRole,
        subjectId: actor.subjectId,
        credential: actor.credential,
        permissions: actor.actorPermissions || [],
      },
    });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!allowPlayAdmin(req, res)) return;
  return res.status(200).json({
    verified: true,
    actor: {
      displayName: '服主密钥',
      username: 'server-owner',
      role: 'owner',
      credential: 'owner-token',
    },
  });
}
