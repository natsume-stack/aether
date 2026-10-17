import type { NextApiRequest, NextApiResponse } from 'next';

import { getPlayWorldResourceStatuses } from '../../../../server/play-admin';
import { allowPlayLibraryAdmin } from '../../../../server/play-admin-security';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;
  try {
    return res.status(200).json({ worlds: getPlayWorldResourceStatuses() });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
}
