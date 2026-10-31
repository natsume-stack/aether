import type { NextApiRequest, NextApiResponse } from 'next';
import { requestPlayerServiceIp } from '../../server/player-service-client';

function internalURL() {
  const value = (process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').trim();
  if (!value) throw new Error('玩家身份服务未配置');
  return value.replace(/\/$/, '');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.BOX_DEPLOYMENT_MODE !== 'play') return res.status(404).end();
  if (!['GET', 'PATCH'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).end();
  }
  try {
    const response = await fetch(`${internalURL()}/api/player-internal/map-library`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${process.env.PERMISSION_TOKEN_SECRET || ''}`,
        Cookie: String(req.headers.cookie || ''),
        'Content-Type': 'application/json',
        'X-Box-Player-IP': requestPlayerServiceIp(req),
        'X-Box-Player-User-Agent': String(req.headers['user-agent'] || '').slice(0, 512),
      },
      body: req.method === 'PATCH' ? JSON.stringify(req.body || {}) : undefined,
    });
    const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = responseHeaders.getSetCookie?.() || [];
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    else {
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) res.setHeader('Set-Cookie', setCookie);
    }
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    const body = await response.text();
    res.status(response.status);
    if (body) return res.send(body);
    return res.end();
  } catch (error) {
    return res.status(503).json({ message: (error as Error).message });
  }
}
