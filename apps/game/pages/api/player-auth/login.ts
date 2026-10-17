import { playerBanResponse } from '../../../server/player-ban-response';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  clearSuccessfulPlayerLoginRateLimits,
  consumePlayerLoginRateLimit,
} from '../../../server/auth-rate-limit';
import { loginPlayer } from '../../../server/local-player-identity';
import {
  authorizePlayerAuthRequest,
  playerAuthClientAddress,
} from '../../../server/player-auth-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'player-service') return res.status(404).end();
  if (!authorizePlayerAuthRequest(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).end();
  }
  const address = playerAuthClientAddress(req);
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const limit = await consumePlayerLoginRateLimit(address, username);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ message: '登录失败次数过多，请稍后再试' });
  }
  try {
    const player = await loginPlayer(req, res, req.body || {});
    await clearSuccessfulPlayerLoginRateLimits(address, username);
    return res.status(200).json({ player });
  } catch (error) {
    const ban = playerBanResponse(error);
    if (ban) return res.status(403).json(ban);
    const message = (error as Error).message;
    return res.status(401).json({ message });
  }
}
