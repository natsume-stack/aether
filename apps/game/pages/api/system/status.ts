import type { NextApiRequest, NextApiResponse } from 'next';

import { allowAuthenticatedCreatorApi } from '../../../server/creator-api-security';
import { getSystemStatus } from '../../../server/system-status';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await allowAuthenticatedCreatorApi(req, res, 'projects.view')) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await getSystemStatus());
  } catch (error) {
    return res.status(500).json({ message: (error as Error).message || '无法读取运行状态' });
  }
}
