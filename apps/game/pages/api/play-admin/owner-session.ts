import type { NextApiRequest, NextApiResponse } from 'next';

import { createPlayerAdminOwnerSession } from '../../../server/player-admin-identity';
import {
  allowPlayerAdminRequestOrigin,
  applyPlayerAdminSecurityHeaders,
  sendPlayerAdminApiError,
} from '../../../server/player-admin-authorization';
import { allowPlayAdmin } from '../../../server/play-admin-security';

export const config = { api: { bodyParser: { sizeLimit: '1kb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  applyPlayerAdminSecurityHeaders(res);
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!allowPlayerAdminRequestOrigin(req, res) || !allowPlayAdmin(req, res)) return;
  try {
    const actor = await createPlayerAdminOwnerSession(req, res);
    return res.status(200).json({ verified: true, actor });
  } catch (error) {
    return sendPlayerAdminApiError(res, error, 'Player admin owner session failed');
  }
}
