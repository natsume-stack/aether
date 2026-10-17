import type { NextApiRequest, NextApiResponse } from 'next';

import { allowPlayLibraryAdmin } from '../../../server/play-admin-security';
import { getPlaySystemStatus } from '../../../server/play-system-status';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!allowPlayLibraryAdmin(req, res)) return;
  try {
    return res.status(200).json(await getPlaySystemStatus());
  } catch (error) {
    return res.status(500).json({ message: (error as Error).message || '无法读取游玩端运行状态' });
  }
}
