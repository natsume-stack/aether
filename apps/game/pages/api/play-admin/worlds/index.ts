import type { NextApiRequest, NextApiResponse } from 'next';

import { getPlayWorlds } from '../../../../server/play-worlds';
import { allowPlayLibraryAdmin } from '../../../../server/play-admin-security';

/** Internal source of truth for the unified player-admin map console. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;
  return res.status(200).json({ worlds: getPlayWorlds() });
}
