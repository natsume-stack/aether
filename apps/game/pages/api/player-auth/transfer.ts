import type { NextApiRequest, NextApiResponse } from 'next';
import { issuePlayerLoginTransfer } from '../../../server/local-player-identity';
import { authorizePlayerAuthRequest } from '../../../server/player-auth-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!authorizePlayerAuthRequest(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  try {
    return res.status(200).json(await issuePlayerLoginTransfer(req, res));
  } catch {
    return res.status(401).json({ message: '登录凭证失效，请重新登录' });
  }
}
