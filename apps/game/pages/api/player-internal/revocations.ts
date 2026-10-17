import type { NextApiRequest, NextApiResponse } from 'next';

import {
  isInternalIdentityRequest,
  listPlayerRevocations,
} from '../../../server/local-player-identity';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  if (!isInternalIdentityRequest(req)) {
    return res.status(401).json({ message: '玩家身份服务内部鉴权失败' });
  }

  const afterValue = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
  const sinceValue = Array.isArray(req.query.since) ? req.query.since[0] : req.query.since;
  const after = Number(afterValue || 0);
  const since = new Date(sinceValue || '');
  if (!Number.isSafeInteger(after) || after < 0 || Number.isNaN(since.getTime())) {
    return res.status(400).json({ message: '下线事件游标无效' });
  }

  try {
    return res.status(200).json(await listPlayerRevocations(after, since));
  } catch (error) {
    return res.status(503).json({ message: (error as Error).message });
  }
}
