import type { NextApiRequest, NextApiResponse } from 'next';

import { allowCreatorApi } from '../../server/creator-api-security';
import {
  PlayerAuthenticationRequiredError,
  requestPlayerServiceIp,
  resolvePlayerServiceIdentity,
} from '../../server/player-service-client';

/** Returns fresh Creator permissions; they are intentionally not cached in the browser session. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!allowCreatorApi(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    const { identity } = await resolvePlayerServiceIdentity(req, res, requestPlayerServiceIp(req));
    if (!identity.creatorAccess) {
      return res.status(403).json({ code: 'CREATOR_ACCESS_REQUIRED', message: '当前账号没有创作权限' });
    }
    return res.status(200).json({ creatorPermissions: identity.creatorPermissions });
  } catch (error) {
    if (error instanceof PlayerAuthenticationRequiredError) {
      return res.status(401).json({ code: 'AUTH_REQUIRED', message: '请先登录账号' });
    }
    return res.status(503).json({ code: 'PLAYER_SERVICE_UNAVAILABLE', message: '无法刷新创作者权限' });
  }
}
