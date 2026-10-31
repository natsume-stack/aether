import type { NextApiRequest, NextApiResponse } from 'next';
import {
  isInternalIdentityRequest,
  redeemPlayerLoginTransfer,
} from '../../../server/local-player-identity';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!isInternalIdentityRequest(req))
    return res.status(401).json({ message: '玩家身份服务内部鉴权失败' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  try {
    return res.status(200).json(await redeemPlayerLoginTransfer(req, res));
  } catch {
    return res.status(401).json({ message: '登录凭证失效，请重新登录' });
  }
}
