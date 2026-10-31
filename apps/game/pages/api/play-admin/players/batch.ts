import type { NextApiRequest, NextApiResponse } from 'next';

import { batchManagePlayers } from '../../../../server/local-player-identity';
import {
  authorizePlayerAdmin,
} from '../../../../server/player-admin-authorization';
import {
  parsePlayerBatch,
  playerBatchRequirement,
} from '../../../../server/player-admin-validation';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const requirement = playerBatchRequirement(req.body);
  const actor = await authorizePlayerAdmin(req, res, requirement);
  if (!actor) return;
  try {
    const input = parsePlayerBatch(req.body);
    return res.status(200).json(await batchManagePlayers(
      input.subjectIds,
      input.action,
      {
        reason: 'reason' in input ? input.reason : undefined,
        bannedUntil: 'bannedUntil' in input ? input.bannedUntil : undefined,
        tag: 'tag' in input ? input.tag : undefined,
      },
      actor,
    ));
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
