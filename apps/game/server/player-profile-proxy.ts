import type { NextApiRequest, NextApiResponse } from 'next';
import { requestPlayerServiceIp } from './player-service-client';

function internalURL() {
  const value = (process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').trim();
  if (!value) throw new Error('玩家身份服务未配置');
  return value.replace(/\/$/, '');
}

export async function proxyPlayerProfile(
  req: NextApiRequest,
  res: NextApiResponse,
  deploymentMode: 'creator' | 'play',
) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== deploymentMode) return res.status(404).end();
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).end();
  }
  try {
    const response = await fetch(`${internalURL()}/api/player-internal/profile`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.PERMISSION_TOKEN_SECRET || ''}`,
        Cookie: String(req.headers.cookie || ''),
        'Content-Type': 'application/json',
        'X-Box-Player-IP': requestPlayerServiceIp(req),
        'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
      },
      body: JSON.stringify(req.body || {}),
    });
    const body = await response.text();
    res.status(response.status);
    return body ? res.send(body) : res.end();
  } catch (error) {
    return res.status(503).json({ message: (error as Error).message });
  }
}
